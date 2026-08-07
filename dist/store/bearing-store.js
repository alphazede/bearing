import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalStringify, hashEvent, parseCommandEnvelope, parseEventEnvelope, } from "../contracts/run.js";
import { decide, initialRunState, replay, } from "../workflow/aggregate.js";
import { planDirectoryValid } from "../journey/plan-directory.js";
import { isObject } from "../contracts/guards.js";
import { assertContained, assertWorkspaceRoot, isWorkspaceRootError, pinWorkspace, pinWorkspaceRoot, safeRollbackCreatedDirectory, } from "../repository/workspace-root.js";
import { planWorkspaceName, visibleWorkspaces, workspaceRelativePath, } from "../repository/workspace-location.js";
const STORE_INTEGRITY_ERROR_CODE_LIST = [
    "corrupt_ledger",
    "future_schema",
    "event_hash_mismatch",
    "previous_hash_mismatch",
    "sequence_mismatch",
    "wrong_run_id",
    "corrupt_snapshot",
    "run_location_conflict",
];
const STORE_INTEGRITY_ERROR_CODES = new Set(STORE_INTEGRITY_ERROR_CODE_LIST);
const MALFORMED_REQUIRED_FILE_ERROR_CODES = new Set([
    "EISDIR",
    "ENOTDIR",
    "ELOOP",
    "EFTYPE",
]);
export class BearingStoreError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
        this.name = "BearingStoreError";
    }
}
export function isStoreIntegrityError(error) {
    return error instanceof BearingStoreError && STORE_INTEGRITY_ERROR_CODES.has(error.code);
}
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const queues = new Map();
/** Durable per-run JSONL store. `root` is the repository/workspace root. */
export class BearingStore {
    options;
    repositoryRoot;
    runsRoot;
    pinnedRoot = null;
    constructor(root, options = {}) {
        this.options = options;
        this.repositoryRoot = resolve(root);
        this.runsRoot = resolve(root, ".bearing", "runs");
    }
    async ensureWorkspaceRoot() {
        if (this.pinnedRoot) {
            try {
                await assertWorkspaceRoot(this.pinnedRoot);
                return this.pinnedRoot;
            }
            catch (err) {
                if (isWorkspaceRootError(err)) {
                    throw storeError("workspace_root_changed", err.message, err);
                }
                throw err;
            }
        }
        try {
            this.pinnedRoot = await pinWorkspaceRoot(this.repositoryRoot);
            return this.pinnedRoot;
        }
        catch (err) {
            if (isWorkspaceRootError(err)) {
                throw storeError("workspace_root_changed", err.message, err);
            }
            throw err;
        }
    }
    async checkWorkspaceRootIfPresent() {
        try {
            return await this.ensureWorkspaceRoot();
        }
        catch (err) {
            if (typeof err === "object" && err !== null && err.code === "ENOENT") {
                return null;
            }
            if (isWorkspaceRootError(err) || (err instanceof BearingStoreError && err.code === "workspace_root_changed")) {
                throw storeError("workspace_root_changed", err.message, err);
            }
            return null;
        }
    }
    async load(runId) {
        this.assertRunId(runId);
        await this.checkWorkspaceRootIfPresent();
        return await this.serialized(runId, () => this.loadUnlocked(runId));
    }
    async apply(command) {
        if (typeof command?.runId === "string")
            this.assertRunId(command.runId);
        const parsed = parseCommandEnvelope(command);
        if (!parsed.ok) {
            const reason = parsed.reason === "future_schema" ? "future_schema" : "malformed_command";
            return { ok: false, reason, state: initialRunState("") };
        }
        await this.checkWorkspaceRootIfPresent();
        return await this.serialized(parsed.value.runId, async () => {
            const home = (await this.resolveHome(parsed.value.runId)) ?? this.legacyHome(parsed.value.runId);
            return this.applyUnlocked(parsed.value, home);
        });
    }
    async compact(runId, cleanlinessProof) {
        this.assertRunId(runId);
        assertCallerCleanlinessProof(cleanlinessProof);
        await this.checkWorkspaceRootIfPresent();
        return await this.serialized(runId, () => this.compactUnlocked(runId, cleanlinessProof));
    }
    async retentionPlan(policy, cleanlinessProof) {
        if (!hasEffectiveRetentionPolicy(policy))
            return [];
        assertRetentionPolicy(policy);
        assertCallerCleanlinessProof(cleanlinessProof);
        const pinned = await this.checkWorkspaceRootIfPresent();
        if (pinned) {
            await this.containOrThrow(pinned, this.runsRoot);
        }
        const runIds = await this.enumerateRunIds();
        const candidates = await Promise.all(runIds.map(async (runId) => {
            let state;
            try {
                state = await this.load(runId);
            }
            catch (error) {
                if (isStoreIntegrityError(error)) {
                    return {
                        runId,
                        action: "skip",
                        reason: error.code,
                    };
                }
                throw error;
            }
            if (!isSettled(state, cleanlinessProof))
                return undefined;
            return {
                runId,
                state,
                updatedAt: retentionUpdatedAt(state),
            };
        }));
        const completed = candidates
            .filter((entry) => entry !== undefined && !("action" in entry))
            .sort(compareRetentionRuns);
        const skipped = candidates
            .filter((entry) => entry !== undefined && "action" in entry)
            .sort((a, b) => a.runId.localeCompare(b.runId));
        const pruneReasons = new Map();
        if (policy.maxAgeDays !== undefined) {
            const now = Date.parse(this.options.now?.() ?? new Date().toISOString());
            if (!Number.isFinite(now))
                throw new RangeError("store clock returned an invalid timestamp");
            const cutoff = now - policy.maxAgeDays * 24 * 60 * 60 * 1_000;
            for (const run of completed) {
                if (retentionTimestamp(run) <= cutoff)
                    pruneReasons.set(run.runId, "max_age_days");
            }
        }
        if (policy.maxCompletedRuns !== undefined) {
            const retained = completed
                .filter((run) => !pruneReasons.has(run.runId))
                .sort((a, b) => compareRetentionRuns(b, a))
                .slice(policy.maxCompletedRuns);
            for (const run of retained)
                pruneReasons.set(run.runId, "max_completed_runs");
        }
        return [
            ...completed.flatMap((run) => {
                const pruneReason = pruneReasons.get(run.runId);
                if (pruneReason !== undefined) {
                    return [{ runId: run.runId, action: "prune", reason: pruneReason }];
                }
                if (policy.compactSettled === true && !isCompactedRunState(run.state)) {
                    return [{ runId: run.runId, action: "compact", reason: "compact_settled" }];
                }
                return [];
            }),
            ...skipped,
        ];
    }
    async applyRetention(policy, cleanlinessProof) {
        const plan = await this.retentionPlan(policy, cleanlinessProof);
        const actions = plan.filter((entry) => entry.action !== "skip");
        for (const entry of actions) {
            if (entry.action === "compact")
                await this.compact(entry.runId, cleanlinessProof);
            else {
                await this.serialized(entry.runId, async () => {
                    const state = await this.loadUnlocked(entry.runId);
                    if (isSettled(state, cleanlinessProof))
                        await this.deleteUnlocked(entry.runId);
                });
            }
        }
        return actions;
    }
    async list(limit = 20) {
        const pinned = await this.checkWorkspaceRootIfPresent();
        if (pinned) {
            await this.containOrThrow(pinned, this.runsRoot);
        }
        const runIds = await this.enumerateRunIds();
        const candidates = await Promise.all(runIds.map(async (runId) => {
            let home;
            try {
                home = await this.resolveHome(runId);
            }
            catch (error) {
                if (isStoreIntegrityError(error))
                    return { runId, modified: -1 };
                throw error;
            }
            if (home === null)
                return { runId, modified: -1 };
            const dir = home.dir;
            try {
                const ledger = await stat(join(dir, "events.jsonl"));
                if (ledger.size > 0)
                    return { runId, modified: ledger.mtimeMs };
            }
            catch { /* A missing ledger is valid only for a compacted snapshot. */ }
            try {
                return { runId, modified: (await stat(join(dir, "snapshot.json"))).mtimeMs };
            }
            catch {
                return { runId, modified: -1 };
            }
        }));
        candidates.sort((a, b) => b.modified - a.modified || a.runId.localeCompare(b.runId));
        const summaries = await Promise.all(candidates.slice(0, 100).map(async ({ runId, modified }) => {
            let state;
            try {
                state = await this.load(runId);
            }
            catch (error) {
                if (isWorkspaceRootError(error) || (error instanceof BearingStoreError && error.code === "workspace_root_changed")) {
                    throw error;
                }
                if (!isStoreIntegrityError(error))
                    throw error;
                return {
                    runId,
                    title: `Unreadable run: ${runId}`,
                    goal: `Integrity check failed (${error.code}). Bearing left this run untouched.`,
                    updatedAt: new Date(modified).toISOString(),
                    unreadable: true,
                    integrityError: error.code,
                };
            }
            if (isCompactedRunState(state)) {
                return {
                    runId,
                    ...state.summary,
                    ...(state.journeyCheckpoint ? { checkpoint: state.journeyCheckpoint } : {}),
                };
            }
            const created = state.events.find((event) => event.type === "workRequestCreated");
            if (!created || typeof created.payload.title !== "string" || typeof created.payload.goal !== "string")
                return undefined;
            const answered = state.journeyCheckpoint?.questionDecisionId === undefined ? undefined : [...state.events].reverse().find((event) => event.type === "ownerAnswered" && event.payload.decisionId === state.journeyCheckpoint?.questionDecisionId && typeof event.payload.answer === "string");
            return { runId, title: created.payload.title, goal: created.payload.goal, updatedAt: state.events.at(-1)?.recordedAt ?? created.recordedAt, ...(state.pendingDecision ? { pendingQuestion: state.pendingDecision.question } : {}), ...(answered ? { checkpointAnswer: answered.payload.answer } : {}), ...(state.journeyCheckpoint ? { checkpoint: state.journeyCheckpoint } : {}) };
        }));
        return summaries.filter((entry) => entry !== undefined).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, Math.max(0, Math.min(limit, 50)));
    }
    async delete(runId) {
        this.assertRunId(runId);
        await this.ensureWorkspaceRoot();
        await this.serialized(runId, () => this.deleteUnlocked(runId));
    }
    async clear() {
        const pinned = await this.checkWorkspaceRootIfPresent();
        if (pinned) {
            await this.containOrThrow(pinned, this.runsRoot);
        }
        const runIds = await this.enumerateRunIds();
        await Promise.all(runIds.map((runId) => this.delete(runId)));
    }
    async applyUnlocked(command, home) {
        const state = await this.loadUnlocked(command.runId, home);
        if (isCompactedRunState(state))
            throw storeError("run_compacted", "compacted runs are sealed");
        const result = decide(state, command, {
            recordedAt: this.options.now?.() ?? new Date().toISOString(),
            nextEventId: this.options.nextEventId ?? randomUUID,
        });
        if (!result.ok || result.events.length === 0) {
            return result.ok
                ? { ...result, durable: true, snapshotWarning: null, migrationWarning: null }
                : result;
        }
        const postCommitBoundary = await this.append(command.runId, result.events[0], home);
        let snapshotWarning = postCommitBoundary === null ? null : warning(postCommitBoundary);
        if (snapshotWarning === null) {
            try {
                await this.writeSnapshot(command.runId, result.state, home);
            }
            catch (error) {
                snapshotWarning = warning(boundaryFrom(error));
            }
        }
        const binding = latestPlanBinding(result.state);
        let migrationWarning = null;
        if (binding !== null && (home.kind !== "visible" || home.workspace !== binding.workspace)) {
            try {
                await this.migrateRun(command.runId, home, binding.workspace);
            }
            catch (error) {
                // The command is already durably committed; the relocation is an audit-trail move that
                // never discards state (migrateRun's verified-rename contract). A refusal leaves the
                // run fully intact in its previous home and the next apply retries, so rejecting the
                // apply here would tell the caller a committed command failed — its retry at the same
                // expectedRevision would then be refused as an illegal_transition, a permanent wedge.
                migrationWarning = {
                    code: "run_migration_failed",
                    reason: error instanceof BearingStoreError ? error.code : "ledger_write_failed",
                    workspace: binding.workspace,
                };
            }
        }
        return { ...result, durable: true, snapshotWarning, migrationWarning };
    }
    async compactUnlocked(runId, cleanlinessProof) {
        const home = (await this.resolveHome(runId)) ?? this.legacyHome(runId);
        const events = await this.readLedger(runId, home);
        let snapshot = await this.readSnapshot(runId, home);
        if (snapshot !== null && snapshot.runId !== runId) {
            throw storeError("wrong_run_id", "snapshot run id mismatch");
        }
        if (snapshot?.compacted !== undefined) {
            const sealed = this.loadCompactedSnapshot(snapshot, events);
            if (!isSettled(sealed, cleanlinessProof)) {
                throw storeError("run_not_settled", "run is not proven settled");
            }
            if (events.length > 0)
                await this.truncateLedger(runId, home);
            return sealed;
        }
        if (snapshot !== null) {
            if (snapshot.revision > events.length) {
                throw storeError("corrupt_snapshot", "snapshot is ahead of ledger");
            }
            const prefixEvents = events.slice(0, snapshot.revision);
            const prefix = prefixEvents.length === 0 ? initialRunState(runId) : this.replayLedger(prefixEvents);
            this.verifySnapshotProjection(snapshot, prefix);
        }
        const replayed = this.replayLedger(events);
        if (!isSettled(replayed, cleanlinessProof)) {
            throw storeError("run_not_settled", "run is not proven settled");
        }
        if (snapshot === null || snapshot.revision !== events.length) {
            await this.writeSnapshot(runId, replayed, home);
            snapshot = await this.readSnapshot(runId, home);
            if (snapshot === null || snapshot.compacted !== undefined || snapshot.revision !== events.length) {
                throw storeError("corrupt_snapshot", "current snapshot regeneration failed");
            }
            if (snapshot.runId !== runId) {
                throw storeError("wrong_run_id", "snapshot run id mismatch");
            }
        }
        this.verifySnapshotProjection(snapshot, replayed);
        const created = events.find((event) => event.type === "workRequestCreated");
        const last = events.at(-1);
        if (!created || !last || typeof created.payload.title !== "string" || typeof created.payload.goal !== "string") {
            throw storeError("corrupt_ledger", "settled run is missing its work request summary");
        }
        const compactedBody = {
            ...snapshotBody(replayed),
            compacted: {
                atSequence: events.length,
                atEventHash: last.hash,
                compactedAt: this.options.now?.() ?? new Date().toISOString(),
            },
            summary: {
                title: created.payload.title,
                goal: created.payload.goal,
                updatedAt: last.recordedAt,
            },
        };
        await this.writeSnapshotBody(runId, compactedBody, home);
        const written = await this.readSnapshot(runId, home);
        if (written === null || canonicalStringify(withoutHash(written)) !== canonicalStringify(compactedBody)) {
            throw storeError("corrupt_snapshot", "compacted snapshot verification failed");
        }
        const sealed = stateFromCompactedSnapshot(written);
        await this.truncateLedger(runId, home);
        return sealed;
    }
    async loadUnlocked(runId, home) {
        const resolved = home ?? (await this.resolveHome(runId)) ?? this.legacyHome(runId);
        const events = await this.readLedger(runId, resolved);
        const snapshot = await this.readSnapshot(runId, resolved);
        if (snapshot === null)
            return events.length === 0 ? initialRunState(runId) : this.replayLedger(events);
        if (snapshot.runId !== runId)
            throw storeError("wrong_run_id", "snapshot run id mismatch");
        if (snapshot.compacted !== undefined)
            return this.loadCompactedSnapshot(snapshot, events);
        if (snapshot.revision > events.length)
            throw storeError("corrupt_snapshot", "snapshot is ahead of ledger");
        const prefixEvents = events.slice(0, snapshot.revision);
        const prefix = prefixEvents.length === 0 ? initialRunState(runId) : this.replayLedger(prefixEvents);
        if (canonicalStringify(snapshotBody(prefix)) !== canonicalStringify(withoutHash(snapshot))) {
            throw storeError("corrupt_snapshot", "snapshot projection disagrees with ledger");
        }
        return this.replayLedger(events);
    }
    loadCompactedSnapshot(snapshot, events) {
        if (events.length !== 0 && events.length !== snapshot.revision) {
            throw storeError("corrupt_snapshot", "compacted snapshot has an incomplete ledger tail");
        }
        if (events.length > 0)
            this.verifySnapshotProjection(snapshot, this.replayLedger(events));
        return stateFromCompactedSnapshot(snapshot);
    }
    verifySnapshotProjection(snapshot, state) {
        if (canonicalStringify(snapshotBody(state)) !== canonicalStringify(snapshotProjectionBody(snapshot))) {
            throw storeError("corrupt_snapshot", "snapshot projection disagrees with ledger");
        }
    }
    async readLedger(runId, home) {
        const pinned = await this.pinFor(home);
        const path = join(home.dir, "events.jsonl");
        if (pinned) {
            await this.containOrThrow(pinned, path);
        }
        let text;
        try {
            text = await readFile(path, "utf8");
        }
        catch (error) {
            if (isWorkspaceRootError(error) || (isObject(error) && error.code === "workspace_root_changed")) {
                throw error;
            }
            if (isMissing(error))
                return [];
            if (isMalformedRequiredFile(error)) {
                throw storeError("corrupt_ledger", "ledger path is not a readable file", error);
            }
            throw error;
        }
        if (text.length === 0)
            return [];
        if (!text.endsWith("\n"))
            throw storeError("corrupt_ledger", "ledger has a truncated final line");
        const events = [];
        let previousHash = "";
        for (const [index, line] of text.slice(0, -1).split("\n").entries()) {
            if (line.length === 0)
                throw storeError("corrupt_ledger", `ledger line ${index + 1} is empty`);
            let value;
            try {
                value = JSON.parse(line);
            }
            catch (error) {
                throw storeError("corrupt_ledger", `ledger line ${index + 1} is not JSON`, error);
            }
            const parsed = parseEventEnvelope(value);
            if (!parsed.ok) {
                throw storeError(parsed.reason === "future_schema" ? "future_schema" : "corrupt_ledger", `ledger line ${index + 1} has an unsupported event`);
            }
            const event = parsed.value;
            if (event.runId !== runId)
                throw storeError("wrong_run_id", `ledger line ${index + 1} has wrong run id`);
            if (event.sequence !== index + 1)
                throw storeError("sequence_mismatch", `ledger line ${index + 1} has wrong sequence`);
            if (event.previousHash !== previousHash) {
                throw storeError("previous_hash_mismatch", `ledger line ${index + 1} has wrong previous hash`);
            }
            const { hash, ...body } = event;
            if (hash !== hashEvent(body))
                throw storeError("event_hash_mismatch", `ledger line ${index + 1} has wrong hash`);
            previousHash = hash;
            events.push(event);
        }
        return events;
    }
    async readSnapshot(runId, home) {
        const pinned = await this.pinFor(home);
        const path = join(home.dir, "snapshot.json");
        if (pinned) {
            await this.containOrThrow(pinned, path);
        }
        let text;
        try {
            text = await readFile(path, "utf8");
        }
        catch (error) {
            if (isWorkspaceRootError(error) || (isObject(error) && error.code === "workspace_root_changed")) {
                throw error;
            }
            if (isMissing(error))
                return null;
            if (isMalformedRequiredFile(error)) {
                throw storeError("corrupt_snapshot", "snapshot path is not a readable file", error);
            }
            throw error;
        }
        let value;
        try {
            value = JSON.parse(text);
        }
        catch (error) {
            throw storeError("corrupt_snapshot", "snapshot is not JSON", error);
        }
        if (!isObject(value))
            throw storeError("corrupt_snapshot", "snapshot is not an object");
        if (typeof value.schemaVersion === "number" && value.schemaVersion > 1) {
            throw storeError("future_schema", "snapshot uses a future schema");
        }
        const snapshot = value;
        if (!validSnapshotShape(snapshot))
            throw storeError("corrupt_snapshot", "snapshot shape is invalid");
        if (snapshot.hash !== digest(canonicalStringify(withoutHash(snapshot)))) {
            throw storeError("corrupt_snapshot", "snapshot hash mismatch");
        }
        return snapshot;
    }
    async append(runId, event, home) {
        const dir = home.dir;
        let pinned = null;
        let firstCreated;
        try {
            if (home.kind === "visible") {
                // The visible workspace already exists (resolveHome found the run
                // inside it), so pin before creating the run directory. The pin is
                // never cached into the legacy pinnedRoot cache.
                pinned = await this.pinFor(home);
                if (pinned === null)
                    throw storeError("workspace_root_changed", "visible workspace is not available");
                await mkdir(dir, { recursive: true });
            }
            else {
                firstCreated = await mkdir(dir, { recursive: true });
                pinned = await pinWorkspaceRoot(this.repositoryRoot);
                this.pinnedRoot = pinned;
            }
        }
        catch (err) {
            if (isWorkspaceRootError(err)) {
                await safeRollbackCreatedDirectory(this.pinnedRoot ?? undefined, firstCreated);
                throw storeError("workspace_root_changed", err.message, err);
            }
            throw err;
        }
        try {
            await this.containOrThrow(pinned, dir);
            await this.containOrThrow(pinned, join(dir, "events.jsonl"));
        }
        catch (err) {
            await safeRollbackCreatedDirectory(pinned, firstCreated);
            if (isWorkspaceRootError(err)) {
                throw storeError("workspace_root_changed", err.message, err);
            }
            throw err;
        }
        const file = await open(join(dir, "events.jsonl"), "a+");
        const originalSize = (await file.stat()).size;
        let boundary = "before-ledger-append";
        let durable = false;
        let failure;
        let postCommitBoundary = null;
        try {
            await this.inject(boundary);
            await file.appendFile(`${JSON.stringify(event)}\n`, "utf8");
            boundary = "after-ledger-append";
            await this.inject(boundary);
            boundary = "before-ledger-file-sync";
            await this.inject(boundary);
            await file.sync();
            boundary = "after-ledger-file-sync";
            await this.inject(boundary);
            boundary = "before-ledger-parent-directory-sync";
            await this.inject(boundary);
            await this.syncLedgerDirectories(dir, firstCreated);
            durable = true;
            boundary = "after-ledger-parent-directory-sync";
            await this.inject(boundary);
        }
        catch (error) {
            if (durable) {
                postCommitBoundary = boundary;
            }
            else {
                try {
                    await file.truncate(originalSize);
                    await file.sync();
                    failure = storeError("ledger_write_failed", `ledger was not committed at ${boundary}`, error);
                }
                catch (rollbackError) {
                    failure = storeError("ledger_write_failed", "ledger write and rollback failed", rollbackError);
                }
            }
        }
        try {
            await file.close();
        }
        catch (error) {
            if (durable)
                postCommitBoundary = boundary;
            else
                failure ??= storeError("ledger_write_failed", "ledger file close failed", error);
        }
        if (failure !== undefined)
            throw failure;
        return postCommitBoundary;
    }
    async syncLedgerDirectories(dir, firstCreated) {
        const directories = [dir];
        if (firstCreated !== undefined) {
            const stop = resolve(firstCreated, "..");
            for (let current = dir; current !== stop; current = resolve(current, "..")) {
                directories.push(current);
            }
            directories.push(stop);
        }
        for (const path of new Set(directories)) {
            const handle = await open(path, "r");
            try {
                await handle.sync();
            }
            finally {
                await handle.close();
            }
        }
    }
    async truncateLedger(runId, home) {
        const pinned = await this.hardPinFor(home);
        const path = join(home.dir, "events.jsonl");
        await this.containOrThrow(pinned, path);
        const file = await open(path, "r+");
        try {
            await file.truncate(0);
            await file.sync();
        }
        finally {
            await file.close();
        }
    }
    async deleteUnlocked(runId) {
        const home = (await this.resolveHome(runId)) ?? this.legacyHome(runId);
        const pinned = await this.hardPinFor(home);
        const dir = home.dir;
        await this.containOrThrow(pinned, dir);
        await rm(dir, { recursive: true, force: true });
    }
    replayLedger(events) {
        try {
            return replay(events);
        }
        catch (error) {
            throw storeError("corrupt_ledger", "ledger has an illegal event history", error);
        }
    }
    async writeSnapshot(runId, state, home) {
        await this.writeSnapshotBody(runId, snapshotBody(state), home);
    }
    async writeSnapshotBody(runId, body, home) {
        const pinned = await this.hardPinFor(home);
        const dir = home.dir;
        await this.containOrThrow(pinned, dir);
        const temp = join(dir, "snapshot.json.tmp");
        await this.containOrThrow(pinned, temp);
        const target = join(dir, "snapshot.json");
        await this.containOrThrow(pinned, target);
        const bytes = `${JSON.stringify({ ...body, hash: digest(canonicalStringify(body)) })}\n`;
        let boundary = "before-snapshot-temp-write";
        try {
            await this.inject(boundary);
            const file = await open(temp, "w");
            try {
                await file.writeFile(bytes, "utf8");
                boundary = "after-snapshot-temp-write";
                await this.inject(boundary);
                boundary = "before-snapshot-temp-file-sync";
                await this.inject(boundary);
                await file.sync();
                boundary = "after-snapshot-temp-file-sync";
                await this.inject(boundary);
            }
            finally {
                await file.close();
            }
            boundary = "before-snapshot-rename";
            await this.inject(boundary);
            await rename(temp, join(dir, "snapshot.json"));
            boundary = "after-snapshot-rename";
            await this.inject(boundary);
            boundary = "before-snapshot-parent-directory-sync";
            await this.inject(boundary);
            const parent = await open(dir, "r");
            try {
                await parent.sync();
            }
            finally {
                await parent.close();
            }
            boundary = "after-snapshot-parent-directory-sync";
            await this.inject(boundary);
        }
        catch (error) {
            throw Object.assign(new Error("snapshot update failed", { cause: error }), { boundary });
        }
    }
    inject(boundary) {
        return this.options.fault?.(boundary);
    }
    runDir(runId) {
        return join(this.runsRoot, runId);
    }
    /**
     * Repository-relative visible per-plan workspace directory of a plan-bound
     * run, disclosed when a journey starts. Undefined while the run is unbound
     * or still in the legacy `.bearing` home.
     */
    async runWorkspaceName(runId) {
        this.assertRunId(runId);
        await this.checkWorkspaceRootIfPresent();
        return await this.serialized(runId, async () => {
            const home = await this.resolveHome(runId);
            if (home === null || home.kind !== "visible")
                return undefined;
            return home.workspace;
        });
    }
    /**
     * Repository-relative POSIX path of a plan-bound run's audit trail
     * (`<workspace>/runs/<runId>`), disclosed when a journey starts. Undefined
     * while the run is unbound or still in the legacy `.bearing` home.
     */
    async runWorkspacePath(runId) {
        this.assertRunId(runId);
        await this.checkWorkspaceRootIfPresent();
        return await this.serialized(runId, async () => {
            const home = await this.resolveHome(runId);
            if (home === null || home.kind !== "visible")
                return undefined;
            return workspaceRelativePath(this.repositoryRoot, home.dir);
        });
    }
    legacyHome(runId) {
        return { kind: "legacy", dir: join(this.runsRoot, runId) };
    }
    /**
     * Locate the single existing home of a run. A run with no directory anywhere
     * is new and defaults to the legacy home. A run found in more than one
     * location fails closed with a typed conflict: two sources of truth are
     * never merged silently.
     */
    async resolveHome(runId) {
        const locations = [];
        if (await pathExists(join(this.runsRoot, runId))) {
            locations.push(this.legacyHome(runId));
        }
        for (const workspace of await visibleWorkspaces(this.repositoryRoot)) {
            const dir = join(this.repositoryRoot, workspace, "runs", runId);
            if (await pathExists(dir)) {
                locations.push({ kind: "visible", dir, workspace });
            }
        }
        if (locations.length > 1) {
            throw storeError("run_location_conflict", `run ${runId} exists in more than one Bearing workspace`);
        }
        return locations[0] ?? null;
    }
    /**
     * Pin the workspace that owns one home. Legacy homes keep the missing
     * `.bearing` semantic (no workspace means no data); a visible home that
     * vanished is a fail-closed workspace_root_changed.
     */
    async pinFor(home) {
        if (home.kind === "visible") {
            try {
                return await pinWorkspace(this.repositoryRoot, home.workspace);
            }
            catch (err) {
                if (isObject(err) && err.code === "ENOENT") {
                    throw storeError("workspace_root_changed", `Workspace directory unavailable at ${join(this.repositoryRoot, home.workspace)}`, err);
                }
                if (isWorkspaceRootError(err))
                    throw storeError("workspace_root_changed", err.message, err);
                throw err;
            }
        }
        return this.checkWorkspaceRootIfPresent();
    }
    async hardPinFor(home) {
        const pinned = await this.pinFor(home);
        if (pinned === null)
            throw storeError("workspace_root_changed", "Bearing workspace is not available");
        return pinned;
    }
    async containOrThrow(pinned, path) {
        return assertContained(pinned, path).catch((err) => {
            if (isWorkspaceRootError(err))
                throw storeError("workspace_root_changed", err.message, err);
            throw err;
        });
    }
    /** Merge run ids from the legacy root and every visible per-plan workspace. */
    async enumerateRunIds() {
        const ids = new Map();
        const legacyEntries = await readdir(this.runsRoot, { withFileTypes: true })
            .catch((error) => { if (isMissing(error))
            return []; throw error; });
        for (const entry of legacyEntries) {
            if (entry.isDirectory() && RUN_ID_RE.test(entry.name))
                ids.set(entry.name, (ids.get(entry.name) ?? 0) + 1);
        }
        for (const workspace of await visibleWorkspaces(this.repositoryRoot)) {
            const runsDir = join(this.repositoryRoot, workspace, "runs");
            const entries = await readdir(runsDir, { withFileTypes: true })
                .catch((error) => { if (isMissing(error))
                return []; throw error; });
            for (const entry of entries) {
                if (entry.isDirectory() && RUN_ID_RE.test(entry.name))
                    ids.set(entry.name, (ids.get(entry.name) ?? 0) + 1);
            }
        }
        return [...ids.keys()];
    }
    /**
     * Atomically move a run's audit trail into the visible per-plan workspace
     * bound by its ledger. Verified rename only: on any failure the run stays
     * fully intact in its previous home and the next apply retries.
     */
    async migrateRun(runId, from, workspaceName) {
        let pin;
        try {
            pin = await pinWorkspace(this.repositoryRoot, workspaceName);
        }
        catch (err) {
            if (isObject(err) && err.code === "ENOENT") {
                await mkdir(join(this.repositoryRoot, workspaceName), { recursive: true });
                try {
                    pin = await pinWorkspace(this.repositoryRoot, workspaceName);
                }
                catch (pinErr) {
                    throw storeError("ledger_write_failed", `run migration could not establish workspace ${workspaceName}`, pinErr);
                }
            }
            else if (isWorkspaceRootError(err)) {
                throw storeError("workspace_root_changed", err.message, err);
            }
            else {
                throw storeError("ledger_write_failed", `run migration could not pin workspace ${workspaceName}`, err);
            }
        }
        const runsDir = join(pin.workspacePath, "runs");
        const targetDir = join(runsDir, runId);
        await mkdir(runsDir, { recursive: true });
        try {
            await this.containOrThrow(pin, runsDir);
            await this.containOrThrow(pin, targetDir);
        }
        catch (err) {
            if (isWorkspaceRootError(err))
                throw storeError("workspace_root_changed", err.message, err);
            throw err;
        }
        if (await pathExists(targetDir)) {
            throw storeError("run_location_conflict", `run ${runId} already exists in workspace ${workspaceName}`);
        }
        const sourceSt = await lstat(from.dir);
        if (sourceSt.isSymbolicLink() || !sourceSt.isDirectory()) {
            throw storeError("workspace_root_changed", `run home at ${from.dir} is not a plain directory`);
        }
        await rename(from.dir, targetDir);
        const moved = await lstat(targetDir).catch(() => undefined);
        if (moved === undefined || !moved.isDirectory()) {
            throw storeError("ledger_write_failed", `run migration verification failed for ${runId}`);
        }
        if (await pathExists(from.dir)) {
            throw storeError("ledger_write_failed", `run migration left the source behind for ${runId}`);
        }
        await this.syncDirectory(resolve(from.dir, ".."));
        await this.syncDirectory(runsDir);
        await this.syncDirectory(pin.workspacePath);
    }
    async syncDirectory(path) {
        const handle = await open(path, "r");
        try {
            await handle.sync();
        }
        finally {
            await handle.close();
        }
    }
    assertRunId(runId) {
        if (!RUN_ID_RE.test(runId))
            throw storeError("invalid_run_id", "invalid run id");
    }
    async serialized(runId, operation) {
        const key = this.runDir(runId);
        const previous = queues.get(key) ?? Promise.resolve();
        let release = () => undefined;
        const gate = new Promise((resolve) => { release = resolve; });
        const tail = previous.then(() => gate);
        queues.set(key, tail);
        await previous;
        try {
            return await operation();
        }
        finally {
            release();
            if (queues.get(key) === tail)
                queues.delete(key);
        }
    }
}
function snapshotBody(state) {
    return {
        schemaVersion: 1,
        runId: state.runId,
        revision: state.revision,
        lastEventHash: state.events.at(-1)?.hash ?? "",
        outcomes: [...state.outcomes.values()].sort((a, b) => a.commandId < b.commandId ? -1 : a.commandId > b.commandId ? 1 : 0),
        pendingDecision: state.pendingDecision,
        workRequestCreated: state.workRequestCreated,
        executionRecommendation: state.executionRecommendation,
        executionApproval: state.executionApproval,
        ...(state.journeyCheckpoint ? { journeyCheckpoint: state.journeyCheckpoint } : {}),
        ...(state.legacyRoleRoutes ? { legacyRoleRoutes: state.legacyRoleRoutes } : {}),
        ...(state.legacyExecutionContract ? { legacyExecutionContract: state.legacyExecutionContract } : {}),
    };
}
function snapshotProjectionBody(snapshot) {
    const { hash: _hash, compacted: _compacted, summary: _summary, ...body } = snapshot;
    return body;
}
function withoutHash(snapshot) {
    const { hash: _hash, ...body } = snapshot;
    return body;
}
function stateFromSnapshot(snapshot) {
    return Object.assign(initialRunState(snapshot.runId), {
        revision: snapshot.revision,
        events: [],
        outcomes: new Map(snapshot.outcomes.map((outcome) => [outcome.commandId, outcome])),
        pendingDecision: snapshot.pendingDecision,
        workRequestCreated: snapshot.workRequestCreated,
        executionRecommendation: snapshot.executionRecommendation,
        executionApproval: snapshot.executionApproval,
        journeyCheckpoint: snapshot.journeyCheckpoint ?? null,
        legacyRoleRoutes: snapshot.legacyRoleRoutes ?? null,
        legacyExecutionContract: snapshot.legacyExecutionContract ?? null,
    });
}
function stateFromCompactedSnapshot(snapshot) {
    if (snapshot.compacted === undefined || snapshot.summary === undefined) {
        throw storeError("corrupt_snapshot", "compacted snapshot is missing terminal metadata");
    }
    return Object.assign(stateFromSnapshot(snapshot), {
        sealed: true,
        summary: snapshot.summary,
    });
}
export function isCompactedRunState(state) {
    return "sealed" in state && state.sealed === true;
}
/**
 * Shared settle proof for compaction and retention.
 *
 * The store proves the event-sourced conditions itself: the final review checkpoint is complete
 * and no owner decision is pending. It trusts the caller for exactly the two transient conditions
 * that cannot safely live in the append-only ledger: there is no dirty or unmerged lane, and the
 * run is not busy. Missing or incomplete caller proof fails closed.
 */
function isSettled(state, cleanlinessProof) {
    const checkpoint = state.journeyCheckpoint;
    return hasCallerCleanlinessProof(cleanlinessProof) &&
        state.pendingDecision === null &&
        checkpoint !== null &&
        checkpoint.stage === "review" &&
        checkpoint.status === "complete";
}
function hasCallerCleanlinessProof(proof) {
    return proof?.noDirtyOrUnmergedLane === true && proof.runNotBusy === true;
}
function assertCallerCleanlinessProof(proof) {
    if (!hasCallerCleanlinessProof(proof)) {
        throw storeError("run_not_settled", "caller cleanliness proof is required");
    }
}
function hasEffectiveRetentionPolicy(policy) {
    return policy !== undefined &&
        (policy.maxAgeDays !== undefined ||
            policy.maxCompletedRuns !== undefined ||
            policy.compactSettled === true);
}
function assertRetentionPolicy(policy) {
    if (policy.maxAgeDays !== undefined &&
        (!Number.isFinite(policy.maxAgeDays) || policy.maxAgeDays < 0)) {
        throw new RangeError("maxAgeDays must be a non-negative finite number");
    }
    if (policy.maxCompletedRuns !== undefined &&
        (!Number.isSafeInteger(policy.maxCompletedRuns) || policy.maxCompletedRuns < 0)) {
        throw new RangeError("maxCompletedRuns must be a non-negative safe integer");
    }
}
function retentionUpdatedAt(state) {
    if (isCompactedRunState(state))
        return state.summary.updatedAt;
    const updatedAt = state.events.at(-1)?.recordedAt;
    if (updatedAt === undefined) {
        throw storeError("corrupt_ledger", "settled run is missing its final event timestamp");
    }
    return updatedAt;
}
function retentionTimestamp(run) {
    const timestamp = Date.parse(run.updatedAt);
    if (!Number.isFinite(timestamp)) {
        throw storeError("corrupt_snapshot", `run ${run.runId} has an invalid retention timestamp`);
    }
    return timestamp;
}
function compareRetentionRuns(a, b) {
    return retentionTimestamp(a) - retentionTimestamp(b) || a.runId.localeCompare(b.runId);
}
function validSnapshotShape(value) {
    const terminal = value.compacted === undefined && value.summary === undefined ||
        isObject(value.compacted) && Object.keys(value.compacted).length === 3 &&
            Number.isSafeInteger(value.compacted.atSequence) && value.compacted.atSequence > 0 &&
            typeof value.compacted.atEventHash === "string" && HASH_RE.test(value.compacted.atEventHash) &&
            typeof value.compacted.compactedAt === "string" && value.compacted.compactedAt.length > 0 &&
            isObject(value.summary) && Object.keys(value.summary).length === 3 &&
            typeof value.summary.title === "string" && value.summary.title.length > 0 &&
            typeof value.summary.goal === "string" && value.summary.goal.length > 0 &&
            typeof value.summary.updatedAt === "string" && value.summary.updatedAt.length > 0 &&
            value.compacted.atSequence === value.revision &&
            value.compacted.atEventHash === value.lastEventHash;
    return value.schemaVersion === 1 &&
        typeof value.runId === "string" &&
        Number.isSafeInteger(value.revision) && value.revision >= 0 &&
        (value.lastEventHash === "" || HASH_RE.test(value.lastEventHash)) &&
        typeof value.workRequestCreated === "boolean" &&
        (value.executionRecommendation === null || isObject(value.executionRecommendation)) &&
        (value.executionApproval === null || isObject(value.executionApproval)) &&
        (value.journeyCheckpoint === undefined || value.journeyCheckpoint === null || isObject(value.journeyCheckpoint)) &&
        (value.legacyRoleRoutes === undefined || value.legacyRoleRoutes === null ||
            (Array.isArray(value.legacyRoleRoutes) && value.legacyRoleRoutes.every((route) => isObject(route)))) &&
        (value.legacyExecutionContract === undefined || value.legacyExecutionContract === null || isObject(value.legacyExecutionContract)) &&
        (value.pendingDecision === null ||
            (isObject(value.pendingDecision) && typeof value.pendingDecision.decisionId === "string" &&
                typeof value.pendingDecision.question === "string")) &&
        Array.isArray(value.outcomes) && value.outcomes.every((outcome) => isObject(outcome) && typeof outcome.commandId === "string" &&
        typeof outcome.contentHash === "string" && HASH_RE.test(outcome.contentHash) &&
        Array.isArray(outcome.eventIds) && outcome.eventIds.every((id) => typeof id === "string")) &&
        terminal &&
        typeof value.hash === "string" && HASH_RE.test(value.hash);
}
function digest(value) {
    return createHash("sha256").update(value).digest("hex");
}
function warning(boundary) {
    return { code: "snapshot_update_failed", boundary };
}
function boundaryFrom(error) {
    if (isObject(error) && typeof error.boundary === "string")
        return error.boundary;
    return "before-snapshot-temp-write";
}
function isMissing(error) {
    return isObject(error) && error.code === "ENOENT";
}
function isMalformedRequiredFile(error) {
    return isObject(error)
        && typeof error.code === "string"
        && MALFORMED_REQUIRED_FILE_ERROR_CODES.has(error.code);
}
/**
 * Latest plan binding recoverable from the run's own ledger. Only a
 * planDirectory that satisfies the plan directory rules binds; anything else
 * is ignored so a run is never renamed into a non-conforming workspace.
 */
function latestPlanBinding(state) {
    const events = state.events;
    for (let index = events.length - 1; index >= 0; index--) {
        const event = events[index];
        if (event.type !== "journeyCheckpointRecorded")
            continue;
        const payload = event.payload;
        const plan = typeof payload.resolvedPlanDirectory === "string"
            ? payload.resolvedPlanDirectory
            : typeof payload.planDirectory === "string"
                ? payload.planDirectory
                : undefined;
        if (plan !== undefined && planDirectoryValid(plan)) {
            return { workspace: planWorkspaceName(plan) };
        }
    }
    return null;
}
async function pathExists(path) {
    try {
        await lstat(path);
        return true;
    }
    catch (error) {
        if (isMissing(error))
            return false;
        throw error;
    }
}
function storeError(code, message, cause) {
    return new BearingStoreError(code, message, cause === undefined ? undefined : { cause });
}
