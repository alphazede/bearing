import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { createServer, request as sendRequest, type Server } from "node:http";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { createFocusContext, validateFocusCompletion, type CommandEvidence, type FocusCompletion, type FocusContext, type FocusContextResult, type FocusRejection, type FocusRole } from "./focus-mode.js";
import { executionReviewValid } from "./planning-journey.js";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024;
const FOCUS_GUARD_LIFETIME_MS = 60 * 60 * 1000;

export interface FocusRequest {
  readonly role: FocusRole;
  readonly objective: string;
  readonly planDirectory: string;
  readonly slice?: string;
  readonly githubIssueMutationAuthorized?: boolean;
}

interface FocusReceipt {
  readonly artifacts: readonly string[];
  readonly evidence: readonly CommandEvidence[];
  readonly githubIssueMutation?: boolean;
}

export type StandaloneFocusFailureReason =
  | Extract<FocusCompletion, { readonly ok: false }>["reason"]
  | "receipt_invalid"
  | "authority_invalid"
  | "review_invalid"
  | "state_invalid"
  | "request_too_large"
  | "request_timeout"
  | "response_too_large";
export type StandaloneFocusResult = { readonly ok: true; readonly changedPaths: readonly string[] } | { readonly ok: false; readonly reason: StandaloneFocusFailureReason };
export type StandaloneFocusDiagnostic = {
  readonly ok: false;
  readonly reason: FocusRejection;
  readonly sliceId?: string;
  readonly field?: string;
  readonly detail?: string;
};
export type StandaloneFocusBegin =
  | { readonly ok: true; readonly runId: string; readonly envelope: unknown }
  | { readonly ok: false; readonly reason: "request_invalid" | "state_invalid" }
  | StandaloneFocusDiagnostic;

function boundedDiagnostic(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return clean || undefined;
}

function standaloneDiagnostic(failure: Extract<FocusContextResult, { readonly ok: false }>): StandaloneFocusDiagnostic {
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

function safeRelative(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && !isAbsolute(value) && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value) && !/(?:^|\/)\.\.(?:\/|$)/.test(value);
}

async function readJson(root: string, path: string): Promise<unknown> {
  if (!safeRelative(path)) return undefined;
  const candidate = resolve(root, path);
  const relation = relative(root, candidate);
  if (!relation || relation.startsWith("..") || isAbsolute(relation)) return undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    const linked = await lstat(candidate);
    if (!stat.isFile() || linked.isSymbolicLink() || stat.size > MAX_FILE_BYTES || stat.dev !== linked.dev || stat.ino !== linked.ino) return undefined;
    return JSON.parse(await handle.readFile("utf8"));
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

export function focusRequest(value: unknown): value is FocusRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every((key) => ["role", "objective", "planDirectory", "slice", "githubIssueMutationAuthorized"].includes(key)) &&
    ["explorer", "navigator", "crewmate"].includes(String(item.role)) && typeof item.objective === "string" && item.objective.length > 0 && item.objective.length <= 4096 && item.objective === item.objective.trim() && typeof item.planDirectory === "string" && safeRelative(item.planDirectory) &&
    (item.slice === undefined || typeof item.slice === "string" && /^(?:[A-Za-z]+\d+|\d+(?:\.\d+)+)$/.test(item.slice)) &&
    (item.role !== "crewmate" && item.role !== "navigator" || typeof item.slice === "string") &&
    (item.githubIssueMutationAuthorized === undefined || typeof item.githubIssueMutationAuthorized === "boolean");
}

function focusReceipt(value: unknown): value is FocusReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every((key) => ["artifacts", "evidence", "githubIssueMutation"].includes(key)) && Array.isArray(item.artifacts) && item.artifacts.length > 0 && item.artifacts.length <= 128 && item.artifacts.every((path) => typeof path === "string" && safeRelative(path)) && new Set(item.artifacts).size === item.artifacts.length && Array.isArray(item.evidence) && (item.githubIssueMutation === undefined || typeof item.githubIssueMutation === "boolean");
}

async function validateStored(context: FocusContext, root: string, issueAuthorized: boolean, receiptPath: string): Promise<StandaloneFocusResult> {
  const receipt = await readJson(root, receiptPath);
  if (!focusReceipt(receipt)) return { ok: false, reason: "receipt_invalid" };
  // CONTRACT-04: for execution stages (standalone Focus crewmate path), the final-QA review
  // artifact must be declared in the receipt. Omission fails closed with artifact_missing
  // even when a pre-completed review hides under a gitignored .bearing/ plan dir.
  const reviewArtifact = context.reviewPath;
  if (!receipt.artifacts.includes(reviewArtifact)) return { ok: false, reason: "artifact_missing" };
  if (receipt.githubIssueMutation === true && !issueAuthorized) return { ok: false, reason: "authority_invalid" };
  const completion = await validateFocusCompletion(context, root, receipt.artifacts, receipt.evidence);
  if (!completion.ok) return completion;
  if (!await executionReviewValid(root, posix.dirname(context.reviewPath))) return { ok: false, reason: "review_invalid" };
  return completion;
}

async function listen(server: Server): Promise<number | undefined> {
  return new Promise((resolveListen) => {
    server.once("error", () => resolveListen(undefined));
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      resolveListen(typeof address === "object" && address ? address.port : undefined);
    });
  });
}

/** Start a loopback guard whose authoritative snapshot remains only in this process. */
export async function beginStandaloneFocus(root: string, requestPath: string): Promise<StandaloneFocusBegin> {
  const canonicalRoot = await realpath(root).catch(() => undefined);
  if (!canonicalRoot) return { ok: false, reason: "request_invalid" };
  const request = await readJson(canonicalRoot, requestPath);
  if (!focusRequest(request)) return { ok: false, reason: "request_invalid" };
  const parsed = await createFocusContext({ root: canonicalRoot, planDirectory: request.planDirectory, role: request.role, objective: request.objective, ...(request.slice ? { currentSlice: request.slice } : {}) });
  if (!parsed.ok) return standaloneDiagnostic(parsed);
  const context = parsed.value;
  const capability = randomBytes(32).toString("hex");
  const issueAuthorized = request.githubIssueMutationAuthorized === true;
  let server!: Server;
  server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let finished = false;
    const finish = (status: number, result: StandaloneFocusResult, consume = true) => {
      if (finished) return;
      finished = true;
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(result), consume ? () => server.close() : undefined);
    };
    if (incoming.method !== "POST" || incoming.url !== `/validate/${capability}`) return finish(404, { ok: false, reason: "state_invalid" }, false);
    incoming.on("data", (chunk: Buffer) => {
      if (finished) return;
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
      if (finished) return;
      void (async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { root?: unknown; receiptPath?: unknown };
          // A mismatched root or missing receiptPath never reaches validation and
          // leaves the immutable guard intact — same rule as 404 and 413 above.
          if (body.root !== canonicalRoot || typeof body.receiptPath !== "string") return finish(400, { ok: false, reason: "state_invalid" }, false);
          const result = await validateStored(context, canonicalRoot, issueAuthorized, body.receiptPath);
          // Correctable receipt, evidence, review, and containment failures retain
          // this exact baseline and capability. Success and terminal authority
          // rejection consume it; the lifetime timer still bounds all correction.
          finish(result.ok ? 200 : 409, result, result.ok || result.reason === "authority_invalid");
          // A body that does not parse never named a receipt to validate. Burning
          // the guard here would make a truncated or mis-encoded request
          // unrecoverable and force the whole Focus run to restart.
        } catch { finish(400, { ok: false, reason: "state_invalid" }, false); }
      })();
    });
  });
  const port = await listen(server);
  if (!port) return { ok: false, reason: "state_invalid" };
  const lifetime = setTimeout(() => server.close(), FOCUS_GUARD_LIFETIME_MS);
  lifetime.unref();
  server.once("close", () => clearTimeout(lifetime));
  return { ok: true, runId: `v1.${port}.${capability}`, envelope: context.envelope };
}

export async function validateStandaloneFocus(root: string, runId: string, receiptPath: string, timeoutMs = 10_000): Promise<StandaloneFocusResult> {
  const match = /^v1\.([1-9][0-9]{0,4})\.([0-9a-f]{64})$/.exec(runId);
  const port = match ? Number(match[1]) : 0;
  if (!match || port > 65_535 || !safeRelative(receiptPath)) return { ok: false, reason: "state_invalid" };
  const canonicalRoot = await realpath(root).catch(() => undefined);
  if (!canonicalRoot) return { ok: false, reason: "state_invalid" };
  const body = JSON.stringify({ root: canonicalRoot, receiptPath });
  return new Promise((resolveResult) => {
    let settled = false;
    let responseStarted = false;
    const finish = (result: StandaloneFocusResult) => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };
    const fail = (reason: StandaloneFocusFailureReason) => finish({ ok: false, reason });
    const request = sendRequest({ host: "127.0.0.1", port, method: "POST", path: `/validate/${match[2]}`, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (response) => {
      responseStarted = true;
      const chunks: Buffer[] = [];
      let length = 0;
      let oversized = false;
      response.on("data", (chunk: Buffer) => {
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
        if (!response.complete) fail(oversized ? "response_too_large" : "state_invalid");
      });
      response.on("end", () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as StandaloneFocusResult;
          finish(typeof result === "object" && result !== null && typeof result.ok === "boolean" ? result : { ok: false, reason: "state_invalid" });
        } catch { fail("state_invalid"); }
      });
    });
    request.setTimeout(timeoutMs, () => {
      fail("request_timeout");
      request.destroy();
    });
    request.once("error", () => fail("state_invalid"));
    request.once("close", () => {
      if (!responseStarted) fail("state_invalid");
    });
    request.end(body);
  });
}
