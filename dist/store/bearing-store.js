import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalStringify, hashEvent, parseCommandEnvelope, parseEventEnvelope, } from "../contracts/run.js";
import { decide, initialRunState, replay, } from "../workflow/aggregate.js";
export class BearingStoreError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
        this.name = "BearingStoreError";
    }
}
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const queues = new Map();
/** Durable per-run JSONL store. `root` is the repository/workspace root. */
export class BearingStore {
    options;
    runsRoot;
    constructor(root, options = {}) {
        this.options = options;
        this.runsRoot = resolve(root, ".bearing", "runs");
    }
    async load(runId) {
        this.assertRunId(runId);
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
        return await this.serialized(parsed.value.runId, () => this.applyUnlocked(parsed.value));
    }
    async list(limit = 20) {
        let entries;
        try {
            entries = await readdir(this.runsRoot, { withFileTypes: true });
        }
        catch (error) {
            if (isMissing(error))
                return [];
            throw error;
        }
        const candidates = await Promise.all(entries.filter((entry) => entry.isDirectory() && RUN_ID_RE.test(entry.name)).map(async (entry) => {
            try {
                return { entry, modified: (await stat(join(this.runsRoot, entry.name, "events.jsonl"))).mtimeMs };
            }
            catch {
                return { entry, modified: -1 };
            }
        }));
        candidates.sort((a, b) => b.modified - a.modified || a.entry.name.localeCompare(b.entry.name));
        const summaries = await Promise.all(candidates.slice(0, 100).map(async ({ entry }) => {
            const state = await this.load(entry.name);
            const created = state.events.find((event) => event.type === "workRequestCreated");
            if (!created || typeof created.payload.title !== "string" || typeof created.payload.goal !== "string")
                return undefined;
            const answered = state.journeyCheckpoint?.questionDecisionId === undefined ? undefined : [...state.events].reverse().find((event) => event.type === "ownerAnswered" && event.payload.decisionId === state.journeyCheckpoint?.questionDecisionId && typeof event.payload.answer === "string");
            return { runId: entry.name, title: created.payload.title, goal: created.payload.goal, updatedAt: state.events.at(-1)?.recordedAt ?? created.recordedAt, ...(state.pendingDecision ? { pendingQuestion: state.pendingDecision.question } : {}), ...(answered ? { checkpointAnswer: answered.payload.answer } : {}), ...(state.journeyCheckpoint ? { checkpoint: state.journeyCheckpoint } : {}) };
        }));
        return summaries.filter((entry) => entry !== undefined).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, Math.max(0, Math.min(limit, 50)));
    }
    async delete(runId) {
        this.assertRunId(runId);
        await this.serialized(runId, () => rm(this.runDir(runId), { recursive: true, force: true }));
    }
    async clear() {
        let entries;
        try {
            entries = await readdir(this.runsRoot, { withFileTypes: true });
        }
        catch (error) {
            if (isMissing(error))
                return;
            throw error;
        }
        await Promise.all(entries.filter((entry) => entry.isDirectory() && RUN_ID_RE.test(entry.name)).map((entry) => this.delete(entry.name)));
    }
    async applyUnlocked(command) {
        const state = await this.loadUnlocked(command.runId);
        const result = decide(state, command, {
            recordedAt: this.options.now?.() ?? new Date().toISOString(),
            nextEventId: this.options.nextEventId ?? randomUUID,
        });
        if (!result.ok || result.events.length === 0) {
            return result.ok
                ? { ...result, durable: true, snapshotWarning: null }
                : result;
        }
        const postCommitBoundary = await this.append(command.runId, result.events[0]);
        let snapshotWarning = postCommitBoundary === null ? null : warning(postCommitBoundary);
        if (snapshotWarning === null) {
            try {
                await this.writeSnapshot(command.runId, result.state);
            }
            catch (error) {
                snapshotWarning = warning(boundaryFrom(error));
            }
        }
        return { ...result, durable: true, snapshotWarning };
    }
    async loadUnlocked(runId) {
        const events = await this.readLedger(runId);
        const snapshot = await this.readSnapshot(runId);
        if (snapshot === null)
            return events.length === 0 ? initialRunState(runId) : this.replayLedger(events);
        if (snapshot.runId !== runId)
            throw storeError("wrong_run_id", "snapshot run id mismatch");
        if (snapshot.revision > events.length)
            throw storeError("corrupt_snapshot", "snapshot is ahead of ledger");
        const prefixEvents = events.slice(0, snapshot.revision);
        const prefix = prefixEvents.length === 0 ? initialRunState(runId) : this.replayLedger(prefixEvents);
        if (canonicalStringify(snapshotBody(prefix)) !== canonicalStringify(withoutHash(snapshot))) {
            throw storeError("corrupt_snapshot", "snapshot projection disagrees with ledger");
        }
        return this.replayLedger(events);
    }
    async readLedger(runId) {
        const path = join(this.runDir(runId), "events.jsonl");
        let text;
        try {
            text = await readFile(path, "utf8");
        }
        catch (error) {
            if (isMissing(error))
                return [];
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
    async readSnapshot(runId) {
        let value;
        try {
            value = JSON.parse(await readFile(join(this.runDir(runId), "snapshot.json"), "utf8"));
        }
        catch (error) {
            if (isMissing(error))
                return null;
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
    async append(runId, event) {
        const dir = this.runDir(runId);
        const firstCreated = await mkdir(dir, { recursive: true });
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
    replayLedger(events) {
        try {
            return replay(events);
        }
        catch (error) {
            throw storeError("corrupt_ledger", "ledger has an illegal event history", error);
        }
    }
    async writeSnapshot(runId, state) {
        const dir = this.runDir(runId);
        const temp = join(dir, "snapshot.json.tmp");
        const body = snapshotBody(state);
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
    };
}
function withoutHash(snapshot) {
    const { hash: _hash, ...body } = snapshot;
    return body;
}
function validSnapshotShape(value) {
    return value.schemaVersion === 1 &&
        typeof value.runId === "string" &&
        Number.isSafeInteger(value.revision) && value.revision >= 0 &&
        (value.lastEventHash === "" || HASH_RE.test(value.lastEventHash)) &&
        typeof value.workRequestCreated === "boolean" &&
        (value.executionRecommendation === null || isObject(value.executionRecommendation)) &&
        (value.executionApproval === null || isObject(value.executionApproval)) &&
        (value.journeyCheckpoint === undefined || value.journeyCheckpoint === null || isObject(value.journeyCheckpoint)) &&
        (value.pendingDecision === null ||
            (isObject(value.pendingDecision) && typeof value.pendingDecision.decisionId === "string" &&
                typeof value.pendingDecision.question === "string")) &&
        Array.isArray(value.outcomes) && value.outcomes.every((outcome) => isObject(outcome) && typeof outcome.commandId === "string" &&
        typeof outcome.contentHash === "string" && HASH_RE.test(outcome.contentHash) &&
        Array.isArray(outcome.eventIds) && outcome.eventIds.every((id) => typeof id === "string")) &&
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
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isMissing(error) {
    return isObject(error) && error.code === "ENOENT";
}
function storeError(code, message, cause) {
    return new BearingStoreError(code, message, cause === undefined ? undefined : { cause });
}
