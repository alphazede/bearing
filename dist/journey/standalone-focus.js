import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { createServer, request as sendRequest } from "node:http";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { createFocusContext, validateFocusCompletion } from "./focus-mode.js";
import { executionReviewValid } from "./planning-journey.js";
const MAX_FILE_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024;
function safeRelative(value) {
    return value.length > 0 && value.length <= 4096 && !isAbsolute(value) && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value) && !/(?:^|\/)\.\.(?:\/|$)/.test(value);
}
async function readJson(root, path) {
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
        return JSON.parse(await handle.readFile("utf8"));
    }
    catch {
        return undefined;
    }
    finally {
        await handle?.close();
    }
}
function focusRequest(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    const item = value;
    return Object.keys(item).every((key) => ["role", "objective", "planDirectory", "slice", "githubIssueMutationAuthorized"].includes(key)) &&
        ["explorer", "navigator", "crewmate"].includes(String(item.role)) && typeof item.objective === "string" && item.objective.length > 0 && item.objective.length <= 4096 && item.objective === item.objective.trim() && typeof item.planDirectory === "string" && safeRelative(item.planDirectory) &&
        (item.slice === undefined || typeof item.slice === "string" && /^(?:[A-Za-z]+\d+|\d+(?:\.\d+)+)$/.test(item.slice)) &&
        (item.role !== "crewmate" || typeof item.slice === "string") &&
        (item.githubIssueMutationAuthorized === undefined || typeof item.githubIssueMutationAuthorized === "boolean");
}
function focusReceipt(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    const item = value;
    return Object.keys(item).every((key) => ["artifacts", "evidence", "githubIssueMutation"].includes(key)) && Array.isArray(item.artifacts) && item.artifacts.length > 0 && item.artifacts.length <= 128 && item.artifacts.every((path) => typeof path === "string" && safeRelative(path)) && new Set(item.artifacts).size === item.artifacts.length && Array.isArray(item.evidence) && (item.githubIssueMutation === undefined || typeof item.githubIssueMutation === "boolean");
}
async function validateStored(context, root, issueAuthorized, receiptPath) {
    const receipt = await readJson(root, receiptPath);
    if (!focusReceipt(receipt))
        return { ok: false, reason: "receipt_invalid" };
    if (receipt.githubIssueMutation === true && !issueAuthorized)
        return { ok: false, reason: "authority_invalid" };
    const completion = await validateFocusCompletion(context, root, receipt.artifacts, receipt.evidence);
    if (!completion.ok)
        return completion;
    if (!await executionReviewValid(root, posix.dirname(context.reviewPath)))
        return { ok: false, reason: "review_invalid" };
    return completion;
}
async function listen(server) {
    return new Promise((resolveListen) => {
        server.once("error", () => resolveListen(undefined));
        server.listen({ host: "127.0.0.1", port: 0 }, () => {
            const address = server.address();
            resolveListen(typeof address === "object" && address ? address.port : undefined);
        });
    });
}
/** Start a one-use loopback guard. Its authoritative snapshot remains only in this process. */
export async function beginStandaloneFocus(root, requestPath) {
    const canonicalRoot = await realpath(root).catch(() => undefined);
    if (!canonicalRoot)
        return { ok: false, reason: "request_invalid" };
    const request = await readJson(canonicalRoot, requestPath);
    if (!focusRequest(request))
        return { ok: false, reason: "request_invalid" };
    const context = await createFocusContext({ root: canonicalRoot, planDirectory: request.planDirectory, role: request.role, objective: request.objective, ...(request.slice ? { currentSlice: request.slice } : {}) });
    if (!context)
        return { ok: false, reason: "focus_invalid" };
    const capability = randomBytes(32).toString("hex");
    const issueAuthorized = request.githubIssueMutationAuthorized === true;
    let server;
    server = createServer((incoming, response) => {
        const chunks = [];
        let length = 0;
        const finish = (status, result) => {
            response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
            response.end(JSON.stringify(result), () => server.close());
        };
        if (incoming.method !== "POST" || incoming.url !== `/validate/${capability}`)
            return finish(404, { ok: false, reason: "state_invalid" });
        incoming.on("data", (chunk) => {
            length += chunk.length;
            if (length > MAX_REQUEST_BYTES)
                incoming.destroy();
            else
                chunks.push(chunk);
        });
        incoming.on("end", () => {
            void (async () => {
                try {
                    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                    if (body.root !== canonicalRoot || typeof body.receiptPath !== "string")
                        return finish(400, { ok: false, reason: "state_invalid" });
                    const result = await validateStored(context, canonicalRoot, issueAuthorized, body.receiptPath);
                    finish(result.ok ? 200 : 409, result);
                }
                catch {
                    finish(400, { ok: false, reason: "state_invalid" });
                }
            })();
        });
    });
    const port = await listen(server);
    if (!port)
        return { ok: false, reason: "state_invalid" };
    return { ok: true, runId: `v1.${port}.${capability}`, envelope: context.envelope };
}
export async function validateStandaloneFocus(root, runId, receiptPath) {
    const match = /^v1\.([1-9][0-9]{0,4})\.([0-9a-f]{64})$/.exec(runId);
    const port = match ? Number(match[1]) : 0;
    if (!match || port > 65_535 || !safeRelative(receiptPath))
        return { ok: false, reason: "state_invalid" };
    const canonicalRoot = await realpath(root).catch(() => undefined);
    if (!canonicalRoot)
        return { ok: false, reason: "state_invalid" };
    const body = JSON.stringify({ root: canonicalRoot, receiptPath });
    return new Promise((resolveResult) => {
        const request = sendRequest({ host: "127.0.0.1", port, method: "POST", path: `/validate/${match[2]}`, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (response) => {
            const chunks = [];
            let length = 0;
            response.on("data", (chunk) => {
                length += chunk.length;
                if (length > MAX_REQUEST_BYTES)
                    response.destroy();
                else
                    chunks.push(chunk);
            });
            response.on("end", () => {
                try {
                    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                    resolveResult(typeof result === "object" && result !== null && typeof result.ok === "boolean" ? result : { ok: false, reason: "state_invalid" });
                }
                catch {
                    resolveResult({ ok: false, reason: "state_invalid" });
                }
            });
        });
        request.setTimeout(10_000, () => request.destroy());
        request.once("error", () => resolveResult({ ok: false, reason: "state_invalid" }));
        request.end(body);
    });
}
