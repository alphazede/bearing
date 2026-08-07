import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { createServer, request as sendRequest } from "node:http";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCrewmatePacketOutcome } from "../contracts/execution-contract.js";
import { isFocusRuntimeIdentity } from "../contracts/run.js";
import { createFocusContext, validateFocusCompletion } from "./focus-mode.js";
import { executionReviewValid } from "./planning-journey.js";
const MAX_FILE_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024;
const FOCUS_GUARD_LIFETIME_MS = 60 * 60 * 1000;
/**
 * Effective guard lifetime in milliseconds. `BEARING_FOCUS_GUARD_LIFETIME_MS`
 * overrides the default when it parses to a positive safe integer; anything
 * else falls back so an unset or malformed variable can never disable the
 * lifetime bound.
 */
function focusGuardLifetimeMs() {
    const value = process.env.BEARING_FOCUS_GUARD_LIFETIME_MS;
    if (value === undefined)
        return FOCUS_GUARD_LIFETIME_MS;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : FOCUS_GUARD_LIFETIME_MS;
}
/**
 * The modules whose semantics the guard executes, in the order the guard's
 * validation path loads them: the guard controller and receipt checks, the
 * Focus context and completion validation, and the review gate completion
 * depends on. A change to any of them is a change in Focus validation
 * behavior, so all of them feed the identity.
 */
const FOCUS_VALIDATION_MODULES = ["standalone-focus", "focus-mode", "planning-journey"];
/** The identity modules' own sources; repairing one of these changes Focus validation semantics. */
const FOCUS_RUNTIME_MODULE_PATHS = FOCUS_VALIDATION_MODULES.map((name) => `src/journey/${name}.ts`);
/**
 * Repository-relative paths a slice may declare when it repairs the Focus
 * runtime itself: the identity modules' sources and the Focus tests. A write
 * set that reaches any other path is an ordinary product slice, which may
 * never bind a receipt to a runtime this guard did not execute.
 */
const FOCUS_RUNTIME_REPAIR_PATHS = [
    ...FOCUS_RUNTIME_MODULE_PATHS,
    "test/focus-mode.test.ts",
    "test/planning-journey.test.ts",
];
async function loadedModuleBytes(name) {
    // The loaded module always sits next to this one; probe the compiled
    // extension first (dist), then the source extension (vitest/tsx).
    for (const extension of [".js", ".ts"]) {
        const candidate = fileURLToPath(new URL(`./${name}${extension}`, import.meta.url));
        try {
            return await readFile(candidate);
        }
        catch {
            // try the next extension
        }
    }
    throw new Error(`Focus runtime identity: module ${name} is not readable`);
}
/**
 * Deterministic identity of this loaded runtime: a sha256 over the bytes of
 * the Focus validation modules, each prefixed with its name and length so the
 * concatenation stays unambiguous. It changes whenever Focus validation
 * semantics change — no hand-maintained version constant to forget, and no git
 * state read. A source build and a dist build of the same code hash
 * differently, so a receipt begun by one is refused by the other.
 */
export async function defaultRuntimeIdentity() {
    const hash = createHash("sha256");
    for (const name of FOCUS_VALIDATION_MODULES) {
        const bytes = await loadedModuleBytes(name);
        hash.update(`${name}:${bytes.length}:`).update(bytes);
    }
    return hash.digest("hex");
}
/**
 * Identity of the Focus runtime as it exists in the repository working tree:
 * the same framing as `defaultRuntimeIdentity` over the identity modules'
 * source files, read from the run's canonical root with the same containment
 * and symlink rules as every other repository read. A repair slice changes
 * those files, so the value recomputed at validation time is the digest of
 * exactly the runtime the slice produced. Unreadable or uncontained sources
 * yield undefined and fail the repair lane closed.
 */
export async function sourceRuntimeIdentity(root) {
    const hash = createHash("sha256");
    for (const name of FOCUS_VALIDATION_MODULES) {
        const content = await sourceText(root, `src/journey/${name}.ts`);
        if (content === undefined)
            return undefined;
        const bytes = Buffer.from(content, "utf8");
        hash.update(`${name}:${bytes.length}:`).update(bytes);
    }
    return hash.digest("hex");
}
/**
 * True when the run's write set (minus the canonical review) stays inside the
 * Focus runtime paths AND reaches at least one runtime module source. A write
 * set touching only Focus tests changes no validation semantics, so it may
 * never bind a receipt to a runtime this guard did not execute.
 */
function isDeclaredRuntimeRepair(context) {
    const writeSet = context.envelope.allowedPaths.filter((path) => path !== context.reviewPath);
    return writeSet.every((path) => FOCUS_RUNTIME_REPAIR_PATHS.includes(path)) && writeSet.some((path) => FOCUS_RUNTIME_MODULE_PATHS.includes(path));
}
function boundedDiagnostic(value, max) {
    if (!value)
        return undefined;
    const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
    return clean || undefined;
}
function standaloneDiagnostic(failure) {
    const sliceId = boundedDiagnostic(failure.sliceId, 128);
    const field = boundedDiagnostic(failure.field, 128);
    const detail = boundedDiagnostic(failure.detail, 512);
    return {
        ok: false,
        reason: failure.reason,
        ...(sliceId ? { sliceId } : {}),
        ...(field ? { field } : {}),
        ...(detail ? { detail } : {}),
    };
}
function safeRelative(value) {
    return value.length > 0 && value.length <= 4096 && !isAbsolute(value) && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value) && !/(?:^|\/)\.\.(?:\/|$)/.test(value);
}
async function sourceText(root, path) {
    if (!safeRelative(path))
        return undefined;
    const candidate = resolve(root, path);
    const relation = relative(root, candidate);
    if (!relation || relation.startsWith("..") || isAbsolute(relation))
        return undefined;
    let handle;
    try {
        handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const stat = await handle.stat();
        const linked = await lstat(candidate);
        if (!stat.isFile() || linked.isSymbolicLink() || stat.size > MAX_FILE_BYTES || stat.dev !== linked.dev || stat.ino !== linked.ino)
            return undefined;
        const content = await handle.readFile("utf8");
        return Buffer.byteLength(content) <= MAX_FILE_BYTES ? content : undefined;
    }
    catch {
        return undefined;
    }
    finally {
        await handle?.close();
    }
}
async function readJson(root, path) {
    const text = await sourceText(root, path);
    if (text === undefined)
        return undefined;
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
export function focusRequest(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    const item = value;
    return Object.keys(item).every((key) => ["role", "objective", "planDirectory", "slice", "githubIssueMutationAuthorized"].includes(key)) &&
        ["explorer", "navigator", "crewmate"].includes(String(item.role)) && typeof item.objective === "string" && item.objective.length > 0 && item.objective.length <= 4096 && item.objective === item.objective.trim() && typeof item.planDirectory === "string" && safeRelative(item.planDirectory) &&
        (item.slice === undefined || typeof item.slice === "string" && /^(?:[A-Za-z]+\d+|\d+(?:\.\d+)+)$/.test(item.slice)) &&
        (item.role !== "crewmate" && item.role !== "navigator" || typeof item.slice === "string") &&
        (item.githubIssueMutationAuthorized === undefined || typeof item.githubIssueMutationAuthorized === "boolean");
}
function focusReceipt(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    const item = value;
    return Object.keys(item).every((key) => ["runtimeIdentity", "artifacts", "evidence", "githubIssueMutation", "taskOutcome"].includes(key)) && isFocusRuntimeIdentity(item.runtimeIdentity) && Array.isArray(item.artifacts) && item.artifacts.length > 0 && item.artifacts.length <= 128 && item.artifacts.every((path) => typeof path === "string" && safeRelative(path)) && new Set(item.artifacts).size === item.artifacts.length && Array.isArray(item.evidence) && (item.githubIssueMutation === undefined || typeof item.githubIssueMutation === "boolean") && (item.taskOutcome === undefined || parseCrewmatePacketOutcome(item.taskOutcome).ok);
}
async function validateStored(context, root, issueAuthorized, receiptPath, runtimeIdentity) {
    const receipt = await readJson(root, receiptPath);
    if (!focusReceipt(receipt))
        return { ok: false, reason: "receipt_invalid" };
    // CONTRACT-05: a receipt begun under any other runtime never validates here.
    // The receipt's identity is the one the begin response returned; a mismatch
    // means the receipt came from a different guard build or was rewritten, and
    // certifying it would bless semantics this guard never executed.
    // CONTRACT-08 (issue 61): the one exception is a declared Focus-runtime
    // repair slice. Its receipt may be bound to the candidate runtime instead of
    // the guard's, but only when that candidate is exactly the runtime now on
    // disk — the identity recomputed from the repaired source matches the
    // receipt, so the bytes certified are precisely what the slice produced, not
    // a swapped or foreign validator. The original context, baseline, and
    // authority rules stay untouched, and any other mismatch remains refused.
    if (receipt.runtimeIdentity !== runtimeIdentity) {
        if (!isDeclaredRuntimeRepair(context))
            return { ok: false, reason: "runtime_mismatch" };
        const produced = await sourceRuntimeIdentity(root);
        if (produced === undefined || produced !== receipt.runtimeIdentity)
            return { ok: false, reason: "runtime_mismatch" };
    }
    // CONTRACT-04: for execution stages (standalone Focus crewmate path), the final-QA review
    // artifact must be declared in the receipt. Omission fails closed with artifact_missing
    // even when a pre-completed review hides under a gitignored .bearing/ plan dir.
    const reviewArtifact = context.reviewPath;
    if (!receipt.artifacts.includes(reviewArtifact))
        return { ok: false, reason: "artifact_missing" };
    if (receipt.githubIssueMutation === true && !issueAuthorized)
        return { ok: false, reason: "authority_invalid" };
    const completion = await validateFocusCompletion(context, root, receipt.artifacts, receipt.evidence);
    if (!completion.ok)
        return completion;
    if (!await executionReviewValid(root, posix.dirname(context.reviewPath)))
        return { ok: false, reason: "review_invalid" };
    return completion;
}
/**
 * Socket-level errors that mean the guard's loopback listener could not be
 * opened: port exhaustion, OS/sandbox permission refusal, or a missing
 * loopback interface. All are environment problems — none is a state
 * conflict, and the caller must be able to tell them apart.
 */
const GUARD_BIND_FAILURE_CODES = new Set(["EADDRINUSE", "EACCES", "EADDRNOTAVAIL"]);
async function listen(server) {
    return new Promise((resolveListen) => {
        server.once("error", (error) => resolveListen({ ok: false, code: error?.code }));
        server.listen({ host: "127.0.0.1", port: 0 }, () => {
            const address = server.address();
            resolveListen(typeof address === "object" && address ? { ok: true, port: address.port } : { ok: false });
        });
    });
}
/** Start a loopback guard whose authoritative snapshot remains only in this process. */
export async function beginStandaloneFocus(root, requestPath, runtimeIdentitySource = defaultRuntimeIdentity) {
    const canonicalRoot = await realpath(root).catch(() => undefined);
    if (!canonicalRoot)
        return { ok: false, reason: "request_invalid" };
    const request = await readJson(canonicalRoot, requestPath);
    if (!focusRequest(request))
        return { ok: false, reason: "request_invalid" };
    const parsed = await createFocusContext({ root: canonicalRoot, planDirectory: request.planDirectory, role: request.role, objective: request.objective, ...(request.slice ? { currentSlice: request.slice } : {}) });
    if (!parsed.ok)
        return standaloneDiagnostic(parsed);
    const context = parsed.value;
    // The guard's runtime identity is fixed at begin and immutable for its whole
    // life: this process can never acquire new validation semantics, and any
    // receipt not bound to this identity must be refused, not certified.
    let runtimeIdentity;
    try {
        runtimeIdentity = await runtimeIdentitySource();
    }
    catch {
        return { ok: false, reason: "state_invalid" };
    }
    if (!isFocusRuntimeIdentity(runtimeIdentity))
        return { ok: false, reason: "state_invalid" };
    const capability = randomBytes(32).toString("hex");
    const issueAuthorized = request.githubIssueMutationAuthorized === true;
    const guardLifetimeMs = focusGuardLifetimeMs();
    let server;
    // The lifetime bounds how long the guard may stay open, but every
    // non-terminal response resets it: a Navigator phase that keeps validating
    // past one hour is still correcting against this same baseline, so a fixed
    // timer must not close the guard under it. Terminal responses consume the
    // guard, and the close handler clears whatever timer is outstanding.
    let lifetimeHandle;
    const resetLifetime = () => {
        if (lifetimeHandle)
            clearTimeout(lifetimeHandle);
        lifetimeHandle = setTimeout(() => server.close(), guardLifetimeMs);
        lifetimeHandle.unref();
    };
    server = createServer((incoming, response) => {
        const chunks = [];
        let length = 0;
        let finished = false;
        const finish = (status, result, consume = true) => {
            if (finished)
                return;
            finished = true;
            response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
            response.end(JSON.stringify(result), consume ? () => server.close() : undefined);
            // The guard stays open for correction: restart the lifetime so a long
            // Navigator phase is bounded by inactivity, not by wall clock from begin.
            if (!consume)
                resetLifetime();
        };
        if (incoming.method !== "POST" || incoming.url !== `/validate/${capability}`)
            return finish(404, { ok: false, reason: "state_invalid" }, false);
        incoming.on("data", (chunk) => {
            if (finished)
                return;
            length += chunk.length;
            if (length > MAX_REQUEST_BYTES) {
                // An oversized body is not a legitimate validate request: answer it so the
                // client settles, but never let it consume the guard before a successful
                // completion or terminal authority rejection.
                finish(413, { ok: false, reason: "request_too_large" }, false);
                return;
            }
            chunks.push(chunk);
        });
        incoming.on("end", () => {
            if (finished)
                return;
            void (async () => {
                try {
                    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                    // A mismatched root or missing receiptPath never reaches validation and
                    // leaves the immutable guard intact — same rule as 404 and 413 above.
                    if (body.root !== canonicalRoot || typeof body.receiptPath !== "string")
                        return finish(400, { ok: false, reason: "state_invalid" }, false);
                    const result = await validateStored(context, canonicalRoot, issueAuthorized, body.receiptPath, runtimeIdentity);
                    // Correctable receipt, evidence, review, and containment failures retain
                    // this exact baseline and capability. Success and terminal authority
                    // rejection consume it; the lifetime timer still bounds all correction.
                    finish(result.ok ? 200 : 409, result, result.ok || result.reason === "authority_invalid");
                    // A body that does not parse never named a receipt to validate. Burning
                    // the guard here would make a truncated or mis-encoded request
                    // unrecoverable and force the whole Focus run to restart.
                }
                catch {
                    finish(400, { ok: false, reason: "state_invalid" }, false);
                }
            })();
        });
    });
    const bound = await listen(server);
    if (!bound.ok) {
        // A bind error is an environment problem, not a state conflict: surface it
        // distinctly so the caller can tell "the guard could not open its
        // loopback listener" from "the plan state is inconsistent". Unknown codes
        // still fail closed as state_invalid.
        return { ok: false, reason: bound.code !== undefined && GUARD_BIND_FAILURE_CODES.has(bound.code) ? "guard_bind_failed" : "state_invalid" };
    }
    resetLifetime();
    server.once("close", () => { if (lifetimeHandle)
        clearTimeout(lifetimeHandle); });
    return { ok: true, runId: `v1.${bound.port}.${capability}`, envelope: context.envelope, runtimeIdentity };
}
export async function validateStandaloneFocus(root, runId, receiptPath, timeoutMs = 10_000, runtimeIdentitySource = defaultRuntimeIdentity) {
    const match = /^v1\.([1-9][0-9]{0,4})\.([0-9a-f]{64})$/.exec(runId);
    const port = match ? Number(match[1]) : 0;
    if (!match || port > 65_535 || !safeRelative(receiptPath))
        return { ok: false, reason: "state_invalid" };
    const canonicalRoot = await realpath(root).catch(() => undefined);
    if (!canonicalRoot)
        return { ok: false, reason: "state_invalid" };
    // Client-side provenance gate: a receipt bound to any runtime other than the
    // one this process loaded must not proceed. The guard's own gate still
    // refuses a mismatched receipt from a direct HTTP client; this one catches a
    // run begun under a stale or different guard before any request is sent.
    // Unreadable receipts are left to the guard, which answers receipt_invalid
    // exactly as it always has. The exception mirrors the guard: a receipt bound
    // to the candidate runtime a declared repair slice produced is forwarded
    // when the candidate recomputes to the exact runtime on disk — the guard
    // still applies its declared-repair-slice rules before certifying anything.
    let currentIdentity;
    try {
        currentIdentity = await runtimeIdentitySource();
    }
    catch {
        return { ok: false, reason: "state_invalid" };
    }
    if (!isFocusRuntimeIdentity(currentIdentity))
        return { ok: false, reason: "state_invalid" };
    const storedReceipt = await readJson(canonicalRoot, receiptPath);
    const recordedIdentity = typeof storedReceipt === "object" && storedReceipt !== null
        ? storedReceipt.runtimeIdentity
        : undefined;
    if (typeof recordedIdentity === "string" && recordedIdentity !== currentIdentity) {
        const produced = await sourceRuntimeIdentity(canonicalRoot);
        if (produced === undefined || produced !== recordedIdentity) {
            return { ok: false, reason: "runtime_mismatch" };
        }
    }
    const body = JSON.stringify({ root: canonicalRoot, receiptPath });
    return new Promise((resolveResult) => {
        let settled = false;
        let responseStarted = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            resolveResult(result);
        };
        const fail = (reason) => finish({ ok: false, reason });
        const request = sendRequest({ host: "127.0.0.1", port, method: "POST", path: `/validate/${match[2]}`, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (response) => {
            responseStarted = true;
            const chunks = [];
            let length = 0;
            let oversized = false;
            response.on("data", (chunk) => {
                length += chunk.length;
                if (length > MAX_REQUEST_BYTES) {
                    oversized = true;
                    fail("response_too_large");
                    response.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            response.once("aborted", () => fail(oversized ? "response_too_large" : "state_invalid"));
            response.once("error", () => fail(oversized ? "response_too_large" : "state_invalid"));
            response.once("close", () => {
                if (!response.complete)
                    fail(oversized ? "response_too_large" : "state_invalid");
            });
            response.on("end", () => {
                try {
                    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                    finish(typeof result === "object" && result !== null && typeof result.ok === "boolean" ? result : { ok: false, reason: "state_invalid" });
                }
                catch {
                    fail("state_invalid");
                }
            });
        });
        request.setTimeout(timeoutMs, () => {
            fail("request_timeout");
            request.destroy();
        });
        request.once("error", () => fail("state_invalid"));
        request.once("close", () => {
            if (!responseStarted)
                fail("state_invalid");
        });
        request.end(body);
    });
}
