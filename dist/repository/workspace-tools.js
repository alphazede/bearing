import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { BUILTIN_ROUTES } from "../adapters/adapters.js";
import { BearingStore, isCompactedRunState, isStoreIntegrityError, } from "../store/bearing-store.js";
import { ignoresBearingDirectory } from "./bootstrap.js";
import { assessRepositorySafety } from "./safety.js";
import { assertContained, assertWorkspaceRoot, isWorkspaceRootError, pinWorkspaceRoot } from "./workspace-root.js";
const BEARING_DIR = ".bearing";
const TEMP_PREFIX = ".bearing.tmp-";
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const HASH_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const BUSY_LEASE_FILE = "busy-lease.json";
/** A crashed server can block maintenance for at most 30 seconds. Live servers refresh every 10 seconds. */
export const BUSY_LEASE_TTL_MS = 30_000;
export async function workspaceStatus(requestedRepository, deps = {}) {
    const repository = await resolveRepository(requestedRepository, deps);
    const isGit = await isGitRoot(repository);
    const safety = assessRepositorySafety({
        candidate: repository,
        isGitRoot: isGit,
        agentExecutableRealpaths: await knownAgentRealpaths(deps.pathEnv ?? process.env.PATH ?? ""),
        ownerConfirmedNonGit: false,
    });
    const bearingPath = join(repository, BEARING_DIR);
    return [
        `Resolved repository: ${repository}`,
        `Bearing workspace: ${bearingPath}`,
        `Workspace bytes: ${await byteSize(bearingPath)} bytes`,
        ...await runBreakdown(repository),
        `Gitignore: ${await ignoresBearing(repository) ? "ignored" : "not ignored"}`,
        `Safety verdict: ${safety.ok ? "safe" : `blocked (${safety.code})`}`,
    ];
}
export async function workspaceCompact(options, deps = {}) {
    if (options.policy?.compactSettled !== true ||
        options.policy.maxAgeDays !== undefined ||
        options.policy.maxCompletedRuns !== undefined) {
        return {
            ok: false,
            lines: ["Refusing compact: an explicit retention policy (--compact-settled) is required."],
        };
    }
    return retentionCommand("compact", options, deps);
}
export async function workspacePrune(options, deps = {}) {
    if (options.policy === undefined ||
        options.policy.compactSettled === true ||
        (options.policy.maxAgeDays === undefined && options.policy.maxCompletedRuns === undefined)) {
        return {
            ok: false,
            lines: ["Refusing prune: an explicit retention policy (--max-age-days or --max-completed-runs) is required."],
        };
    }
    return retentionCommand("prune", options, deps);
}
export async function workspaceDoctor(options, deps = {}) {
    const home = resolve(deps.home ?? homedir());
    const requested = options.relocate === undefined ? undefined : resolve(options.relocate);
    if (requested && basename(requested) !== BEARING_DIR) {
        return { ok: false, lines: [`Refusing relocation: target must be a directory named ${BEARING_DIR}.`] };
    }
    const candidates = new Set([join(home, BEARING_DIR)]);
    for (const scan of options.scans) {
        if (!isAbsolute(scan)) {
            return { ok: false, lines: [`Refusing scan: path must be absolute: ${scan}`] };
        }
        const path = resolve(scan);
        candidates.add(basename(path) === BEARING_DIR ? path : join(path, BEARING_DIR));
    }
    const detected = [];
    for (const candidate of candidates) {
        if (await isDirectory(candidate))
            detected.push(candidate);
    }
    if (requested && !detected.includes(requested)) {
        return { ok: false, lines: [`Refusing relocation: ${requested} was not detected by this bounded scan.`] };
    }
    const agentRealpaths = await knownAgentRealpaths(deps.pathEnv ?? process.env.PATH ?? "");
    const lines = await Promise.all(detected.map(async (path) => {
        const repository = dirname(path);
        const safety = assessRepositorySafety({
            candidate: repository,
            isGitRoot: await isGitRoot(repository),
            agentExecutableRealpaths: agentRealpaths,
            ownerConfirmedNonGit: false,
        });
        if (repository === home) {
            return `MISPLACED: ${path} — quarantine it after confirming no Bearing run is active.`;
        }
        if (!safety.ok) {
            return `MISPLACED: ${path} — ${safety.remedy}`;
        }
        return `OK: ${path} — repository workspace is safe.`;
    }));
    if (!requested) {
        return { ok: true, lines: lines.length ? lines : ["No .bearing workspaces detected."] };
    }
    // Bootstrap's sibling .bearing.tmp-* marker is the conservative on-disk
    // signal that initialization may still be active or interrupted.
    if ((await readdir(dirname(requested))).some((entry) => entry.startsWith(TEMP_PREFIX))) {
        return {
            ok: false,
            lines: [...lines, `Refusing relocation: an in-progress or interrupted initialization marker exists beside ${requested}.`],
        };
    }
    const now = deps.now?.() ?? new Date();
    if (await busyLeaseState(dirname(requested), now) === "busy") {
        return {
            ok: false,
            lines: [...lines, `Refusing relocation: a Bearing run is active in ${requested}.`],
        };
    }
    const timestamp = now.toISOString().replace(/[:.]/g, "-");
    const quarantine = join(dirname(requested), `${BEARING_DIR}.quarantine-${timestamp}`);
    await rename(requested, quarantine);
    return { ok: true, lines: [...lines, `Relocated: ${requested} -> ${quarantine}`] };
}
/**
 * Atomically publishes or clears the one repository-scoped live busy lease.
 * The ledger never receives this transient fact. A live server refreshes the
 * lease every 10 seconds; readers ignore it only after the explicit 30-second
 * expiry, so a crashed server cannot deadlock maintenance indefinitely.
 */
export async function writeWorkspaceBusyLease(repository, runIds, now = new Date()) {
    const root = await directoryRealpath(repository);
    const uniqueRunIds = [...new Set(runIds)].sort();
    if (uniqueRunIds.some((runId) => !RUN_ID_RE.test(runId))) {
        throw new Error("busy lease contains an invalid run id");
    }
    if (uniqueRunIds.length === 0) {
        const workspace = await safeWorkspaceDirectory(root, false);
        if (workspace === undefined)
            return;
        const leasePath = join(workspace, BUSY_LEASE_FILE);
        await rm(leasePath, { force: true });
        return;
    }
    const workspace = await safeWorkspaceDirectory(root, true);
    const pinned = await pinWorkspaceRoot(root);
    const leasePath = join(workspace, BUSY_LEASE_FILE);
    const expiresAt = new Date(now.getTime() + BUSY_LEASE_TTL_MS).toISOString();
    if (!Number.isFinite(now.getTime()))
        throw new Error("busy lease clock is invalid");
    const body = `${JSON.stringify({ schemaVersion: 1, runIds: uniqueRunIds, expiresAt })}\n`;
    const temporary = join(workspace, `.${BUSY_LEASE_FILE}.${randomUUID()}.tmp`);
    await assertContained(pinned, temporary);
    await assertContained(pinned, leasePath);
    let handle;
    try {
        handle = await open(temporary, "wx", 0o600);
        await handle.writeFile(body, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, leasePath);
    }
    finally {
        await handle?.close();
        await rm(temporary, { force: true });
    }
}
async function safeWorkspaceDirectory(repository, create) {
    const workspace = join(repository, BEARING_DIR);
    if (create)
        await mkdir(workspace, { recursive: true, mode: 0o700 });
    let entry;
    try {
        entry = await lstat(workspace);
    }
    catch (error) {
        if (!create && isNodeError(error, "ENOENT"))
            return undefined;
        throw error;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(workspace) !== workspace) {
        throw new Error("Bearing workspace is symlinked or resolves outside the selected repository");
    }
    try {
        const pinned = await pinWorkspaceRoot(repository);
        await assertWorkspaceRoot(pinned);
    }
    catch (err) {
        throw new Error("Bearing workspace is symlinked or resolves outside the selected repository", { cause: err });
    }
    return workspace;
}
async function retentionCommand(command, options, deps) {
    const repository = await resolveRepository(options.repository, deps);
    const policy = options.policy;
    const planProof = await liveCallerCleanlinessProof(repository, deps);
    const store = deps.storeFactory?.(repository) ?? new BearingStore(repository);
    const plan = await store.retentionPlan(policy, planProof);
    const planLines = [
        "Plan:",
        ...(plan.length === 0
            ? ["No matching runs."]
            : plan.map((entry) => `${entry.action} ${entry.runId} (${entry.reason})`)),
    ];
    options.onPlan?.(planLines);
    // Recheck immediately after printing and immediately before the destructive
    // store call. The first proof is intentionally not reused across that gap.
    const actionProof = await liveCallerCleanlinessProof(repository, deps);
    const applied = await store.applyRetention(policy, actionProof);
    return {
        ok: true,
        lines: [`Applied ${applied.length} ${command} ${applied.length === 1 ? "action" : "actions"}.`],
    };
}
async function resolveRepository(requestedRepository, deps) {
    return requestedRepository
        ? await directoryRealpath(requestedRepository)
        : await discoverGitRoot(deps.cwd ?? process.cwd()) ?? await directoryRealpath(deps.cwd ?? process.cwd());
}
async function runBreakdown(repository) {
    const runsRoot = join(repository, BEARING_DIR, "runs");
    let entries;
    try {
        entries = await readdir(runsRoot, { withFileTypes: true });
    }
    catch (error) {
        if (isNodeError(error, "ENOENT"))
            return ["Runs: 0 (settled: 0, unsettled: 0, compacted: 0)"];
        throw error;
    }
    const store = new BearingStore(repository);
    const states = await Promise.all(entries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && RUN_ID_RE.test(entry.name))
        .map(async (entry) => {
        try {
            return { runId: entry.name, state: await store.load(entry.name) };
        }
        catch (error) {
            if (isStoreIntegrityError(error)) {
                return { runId: entry.name, integrityError: error.code };
            }
            throw error;
        }
    }));
    let settled = 0;
    let unsettled = 0;
    let compacted = 0;
    const unreadableRuns = [];
    for (const entry of states) {
        if (entry.state === undefined) {
            unreadableRuns.push({ runId: entry.runId, integrityError: entry.integrityError });
            continue;
        }
        const { state } = entry;
        if (isCompactedRunState(state))
            compacted += 1;
        else if (state.pendingDecision === null &&
            state.journeyCheckpoint?.stage === "review" &&
            state.journeyCheckpoint.status === "complete")
            settled += 1;
        else
            unsettled += 1;
    }
    if (unreadableRuns.length === 0) {
        return [`Runs: ${states.length} (settled: ${settled}, unsettled: ${unsettled}, compacted: ${compacted})`];
    }
    unreadableRuns.sort((a, b) => a.runId.localeCompare(b.runId));
    return [
        `Runs: ${states.length} (settled: ${settled}, unsettled: ${unsettled}, compacted: ${compacted}, unreadable: ${unreadableRuns.length})`,
        `Unreadable runs: ${unreadableRuns.map((entry) => `${entry.runId} (${entry.integrityError})`).join(", ")}`,
    ];
}
async function liveCallerCleanlinessProof(repository, deps) {
    const git = deps.git ?? defaultGit;
    const listed = await git(repository, ["worktree", "list", "--porcelain", "-z"]);
    if (listed.exitCode !== 0)
        throw new Error("could not determine the Git worktree set");
    const worktrees = parseWorktrees(listed.stdout);
    const canonicalRepository = await directoryRealpath(repository);
    const canonicalWorktrees = await Promise.all(worktrees.map(async (worktree) => ({
        ...worktree,
        path: await directoryRealpath(worktree.path).catch(() => {
            throw new Error("could not determine a linked worktree path");
        }),
    })));
    if (!canonicalWorktrees.some((worktree) => worktree.path === canonicalRepository)) {
        throw new Error("could not determine the selected repository in the Git worktree set");
    }
    const rootHead = await git(repository, ["rev-parse", "--verify", "HEAD"]);
    const canonicalRootHead = rootHead.stdout.trim();
    if (rootHead.exitCode !== 0 || !HASH_RE.test(canonicalRootHead)) {
        throw new Error("could not determine the selected repository HEAD");
    }
    for (const worktree of canonicalWorktrees) {
        const status = await git(worktree.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
        if (status.exitCode !== 0)
            throw new Error(`could not determine worktree cleanliness: ${worktree.path}`);
        if (status.stdout.length > 0)
            return undefined;
        const head = await git(worktree.path, ["rev-parse", "--verify", "HEAD"]);
        const currentHead = head.stdout.trim();
        if (head.exitCode !== 0 || !HASH_RE.test(currentHead) || currentHead !== worktree.head) {
            throw new Error(`could not determine a stable worktree HEAD: ${worktree.path}`);
        }
        const merged = await git(repository, ["merge-base", "--is-ancestor", currentHead, canonicalRootHead]);
        if (merged.exitCode === 1)
            return undefined;
        if (merged.exitCode !== 0)
            throw new Error(`could not determine whether a worktree is merged: ${worktree.path}`);
    }
    const lease = await busyLeaseState(repository, deps.now?.() ?? new Date());
    if (lease === "busy")
        return undefined;
    return { noDirtyOrUnmergedLane: true, runNotBusy: true };
}
function parseWorktrees(output) {
    const fields = output.split("\0");
    if (fields.at(-1) !== "")
        throw new Error("could not determine the Git worktree set");
    const records = [];
    let record = [];
    for (const field of fields.slice(0, -1)) {
        if (field === "") {
            if (record.length === 0)
                continue;
            records.push(record);
            record = [];
        }
        else {
            record.push(field);
        }
    }
    if (record.length)
        records.push(record);
    if (records.length === 0)
        throw new Error("could not determine the Git worktree set");
    return records.map((fieldsForRecord) => {
        const values = new Map();
        for (const field of fieldsForRecord) {
            const separator = field.indexOf(" ");
            const key = separator === -1 ? field : field.slice(0, separator);
            const value = separator === -1 ? "" : field.slice(separator + 1);
            if (!["worktree", "HEAD", "branch", "detached", "locked", "prunable"].includes(key)) {
                throw new Error("could not determine the Git worktree set");
            }
            const entries = values.get(key) ?? [];
            entries.push(value);
            values.set(key, entries);
        }
        const path = values.get("worktree");
        const head = values.get("HEAD");
        const branch = values.get("branch");
        const detached = values.get("detached");
        if (path?.length !== 1 || !path[0] || head?.length !== 1 || !HASH_RE.test(head[0]) ||
            (branch?.length === 1) === (detached?.length === 1) ||
            (branch !== undefined && (branch.length !== 1 || !branch[0]?.startsWith("refs/heads/"))) ||
            (detached !== undefined && (detached.length !== 1 || detached[0] !== ""))) {
            throw new Error("could not determine the Git worktree set");
        }
        return { path: path[0], head: head[0] };
    });
}
async function busyLeaseState(repository, now) {
    const workspace = join(repository, BEARING_DIR);
    try {
        const pinned = await pinWorkspaceRoot(repository);
        await assertWorkspaceRoot(pinned);
    }
    catch (error) {
        if (isWorkspaceRootError(error)) {
            throw new Error("busy lease is unreadable or ambiguous", { cause: error });
        }
        if (isNodeError(error, "ENOENT"))
            return "idle";
        throw error;
    }
    const path = join(workspace, BUSY_LEASE_FILE);
    let handle;
    try {
        handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const info = await handle.stat();
        if (!info.isFile() || info.size <= 0 || info.size > 4096) {
            throw new Error("busy lease is unreadable or ambiguous");
        }
        const parsed = JSON.parse(await handle.readFile("utf8"));
        if (!isBusyLease(parsed))
            throw new Error("busy lease is unreadable or ambiguous");
        const expires = Date.parse(parsed.expiresAt);
        const current = now.getTime();
        if (!Number.isFinite(current) || expires > current + BUSY_LEASE_TTL_MS) {
            throw new Error("busy lease is unreadable or ambiguous");
        }
        return expires <= current ? "idle" : "busy";
    }
    catch (error) {
        if (isNodeError(error, "ENOENT"))
            return "idle";
        if (error instanceof Error && error.message === "busy lease is unreadable or ambiguous")
            throw error;
        throw new Error("busy lease is unreadable or ambiguous", { cause: error });
    }
    finally {
        await handle?.close();
    }
}
function isBusyLease(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    const record = value;
    if (Object.keys(record).sort().join(",") !== "expiresAt,runIds,schemaVersion" ||
        record.schemaVersion !== 1 ||
        !Array.isArray(record.runIds) ||
        record.runIds.length === 0 ||
        record.runIds.length > 128 ||
        !record.runIds.every((runId) => typeof runId === "string" && RUN_ID_RE.test(runId)) ||
        new Set(record.runIds).size !== record.runIds.length ||
        typeof record.expiresAt !== "string")
        return false;
    const expires = Date.parse(record.expiresAt);
    return Number.isFinite(expires) && new Date(expires).toISOString() === record.expiresAt;
}
const defaultGit = (cwd, args) => new Promise((resolveResult, reject) => {
    execFile("git", [...args], {
        cwd,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout) => {
        if (error === null) {
            resolveResult({ exitCode: 0, stdout });
            return;
        }
        const code = error.code;
        if (typeof code === "number")
            resolveResult({ exitCode: code, stdout });
        else
            reject(error);
    });
});
async function discoverGitRoot(start) {
    let current = await directoryRealpath(start);
    for (;;) {
        if (await isGitRoot(current))
            return current;
        const parent = dirname(current);
        if (parent === current)
            return undefined;
        current = parent;
    }
}
async function directoryRealpath(path) {
    const resolved = await realpath(path);
    if (!await isDirectory(resolved))
        throw new Error(`not a directory: ${path}`);
    return resolved;
}
async function isDirectory(path) {
    return lstat(path).then((entry) => entry.isDirectory() && !entry.isSymbolicLink()).catch(() => false);
}
async function isGitRoot(path) {
    return lstat(join(path, ".git"))
        .then((entry) => entry.isDirectory() || entry.isFile())
        .catch(() => false);
}
async function byteSize(path) {
    let entry;
    try {
        entry = await lstat(path);
    }
    catch (error) {
        if (isNodeError(error, "ENOENT"))
            return 0;
        throw error;
    }
    if (entry.isSymbolicLink())
        return 0;
    if (entry.isFile())
        return entry.size;
    if (!entry.isDirectory())
        return 0;
    const sizes = await Promise.all((await readdir(path)).map((name) => byteSize(join(path, name))));
    return sizes.reduce((total, size) => total + size, 0);
}
// Bootstrap owns the single authoritative `.bearing` ignore rule set; status must
// never contradict it with a narrower list of its own.
async function ignoresBearing(repository) {
    const path = join(repository, ".gitignore");
    let handle;
    try {
        handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const opened = await handle.stat();
        const linked = await lstat(path);
        if (!opened.isFile()
            || !linked.isFile()
            || linked.isSymbolicLink()
            || opened.dev !== linked.dev
            || opened.ino !== linked.ino)
            return false;
        return ignoresBearingDirectory(await handle.readFile("utf8"));
    }
    catch (error) {
        if (isNodeError(error, "ENOENT") || isNodeError(error, "ELOOP"))
            return false;
        throw error;
    }
    finally {
        await handle?.close();
    }
}
async function knownAgentRealpaths(pathEnv) {
    const found = [];
    for (const { executable } of BUILTIN_ROUTES) {
        for (const directory of pathEnv.split(delimiter).filter(isAbsolute)) {
            const candidate = join(directory, executable);
            try {
                await access(candidate, constants.X_OK);
                found.push(await realpath(candidate));
                break;
            }
            catch { /* try the next absolute PATH entry */ }
        }
    }
    return [...new Set(found)];
}
function isNodeError(error, code) {
    return error instanceof Error && "code" in error && error.code === code;
}
