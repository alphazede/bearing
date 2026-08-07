import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rm, stat, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { isObject } from "../contracts/guards.js";

import {
  assertWorkspaceRoot,
  isWorkspaceRootError,
  pinWorkspaceRoot,
  type PinnedWorkspaceRoot,
} from "../repository/workspace-root.js";
import { NodeProcessRunner } from "../adapters/process-runner.js";
import { ROLE_KINDS } from "../contracts/execution-contract.js";
import { RECORD_JOURNEY_CHECKPOINT_STAGES, REVIEW_CLASSES, REVIEW_VERDICTS } from "../contracts/run.js";
import type { RetryWarrant } from "../execution/retry-control.js";
import { beginStandaloneFocus, validateStandaloneFocus } from "../journey/standalone-focus.js";
import {
  admitRepositoryRoot,
  applyLegacyExecutionContractApproval,
  applyLegacyRoleRouteApproval,
  executeHeadlessJourney,
  readDurableContinuation,
  readReviewContext,
  recordReviewGate,
  type DurableRunContinuation,
  type HeadlessJourneyAction,
  type HeadlessJourneyReceipt,
  type HeadlessJourneyRequest,
  type LegacyExecutionContractRequest,
  type LegacyRoleRouteRequest,
  type ReviewGateRequest,
} from "../server/local-session.js";

type JsonRpcId = string | number | null;

const PUBLIC_RETRY_WARRANTS = [
  "new_hypothesis",
  "new_evidence",
  "changed_strategy",
  "changed_environment",
] as const satisfies readonly RetryWarrant[];
type PublicRetryWarrant = (typeof PUBLIC_RETRY_WARRANTS)[number];

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Newest first. A request that names anything else is refused, not guessed. */
export const MCP_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18"] as const;

const SERVER_INFO = { name: "bearing", version: "0.1.7" } as const;
/** Modern per-request and per-result metadata keys. Legacy carries neither. */
const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo";
const CONTINUATION_SCHEMA_VERSION = 1;
const MAX_STDIO_LINE = 1_048_576;
const UNSUPPORTED_PROTOCOL = -32022;
// A crashed writer must not park the run forever; a held lock older than this is reclaimed.
// ponytail: one lock file per run, reclaimed by mtime. A real lease service only if MCP hosts
// ever share a network filesystem, where mtime skew makes this unsound.
const LOCK_STALE_MS = 120_000;
const LOCK_ROOT = join(tmpdir(), `bearing-mcp-locks-${typeof process.getuid === "function" ? process.getuid() : "user"}`);

async function lockPath(repositoryPath: string, runId: string): Promise<string> {
  await mkdir(LOCK_ROOT, { recursive: true, mode: 0o700 });
  const root = await lstat(LOCK_ROOT);
  if (!root.isDirectory() || root.isSymbolicLink() || await realpath(LOCK_ROOT) !== LOCK_ROOT) {
    throw new Error("MCP lock root is not a private directory");
  }
  if (process.platform !== "win32" && (root.mode & 0o077) !== 0) {
    throw new Error("MCP lock root permissions are not private");
  }
  if (typeof process.getuid === "function" && root.uid !== process.getuid()) {
    throw new Error("MCP lock root is owned by another user");
  }
  const identity = createHash("sha256").update(repositoryPath).update("\0").update(runId).digest("hex");
  return join(LOCK_ROOT, `${identity}.lock`);
}

const TRANSITION_ACTIONS = [
  "create", "resume", "status", "progress", "decide",
  "approve-route", "confirm-amendment", "select-execution", "select-explorer",
] as const satisfies readonly HeadlessJourneyAction[];

const TEXT = (maxLength: number) => ({ type: "string", minLength: 1, maxLength } as const);
const READ_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["repository", "runId"],
  properties: {
    repository: TEXT(4_096),
    runId: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" },
  },
} as const;
const TRANSITION_SCHEMA = {
  // Threat boundary: an MCP caller may select only a syntactically bounded plan slice;
  // traversal is rejected here and Focus later proves that the slice exists in the plan.
  type: "object",
  additionalProperties: false,
  required: ["repository", "runId", "action", "expectedRevision"],
  properties: {
    ...READ_SCHEMA.properties,
    action: { type: "string", enum: TRANSITION_ACTIONS },
    expectedRevision: { type: "integer", minimum: 0 },
    goal: TEXT(4_096),
    answer: TEXT(4_096),
    stage: { type: "string", enum: RECORD_JOURNEY_CHECKPOINT_STAGES },
    executionMode: { type: "string", enum: ["explorer", "expedition"] },
    reviewCadence: { type: "string", enum: ["slice", "phase", "end"] },
    currentSlice: { type: "string", maxLength: 128, pattern: "^(?:[A-Za-z]+\\d+|\\d+(?:\\.\\d+)+)$" },
    provider: TEXT(64),
    model: TEXT(128),
    reasoning: TEXT(32),
    retryWarrant: { type: "string", enum: PUBLIC_RETRY_WARRANTS },
  },
} as const;

const RELATIVE_PATH = TEXT(4_096);
const FOCUS_BEGIN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["repository", "requestPath"],
  properties: { repository: READ_SCHEMA.properties.repository, requestPath: RELATIVE_PATH },
} as const;
const FOCUS_VALIDATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["repository", "focusRunId", "receiptPath"],
  properties: {
    repository: READ_SCHEMA.properties.repository,
    focusRunId: { type: "string", maxLength: 128, pattern: "^v1\\.[1-9][0-9]{0,4}\\.[0-9a-f]{64}$" },
    receiptPath: RELATIVE_PATH,
  },
} as const;
const REVIEW_CONTEXT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["repository", "runId", "reviewClass"],
  properties: {
    ...READ_SCHEMA.properties,
    reviewClass: { type: "string", enum: REVIEW_CLASSES },
  },
} as const;
const REVIEW_RECORD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "repository", "runId", "reviewClass", "expectedRevision",
    "reviewedRevision", "contractHash", "scope", "verdict", "commands", "findings",
  ],
  properties: {
    ...REVIEW_CONTEXT_SCHEMA.properties,
    expectedRevision: { type: "integer", minimum: 0 },
    reviewedRevision: { type: "string", pattern: "^[0-9a-f]{40,64}$" },
    contractHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    scope: {
      type: "array",
      minItems: 1,
      maxItems: 128,
      items: { type: "string", maxLength: 128, pattern: "^(?:[A-Za-z]+\\d+|\\d+(?:\\.\\d+)+)$" },
    },
    verdict: { type: "string", enum: REVIEW_VERDICTS },
    commands: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["commandId", "status", "summary"],
        properties: {
          commandId: { type: "string", maxLength: 128, pattern: "^(?:CMD|PROC)-[A-Z0-9][A-Z0-9.-]*$" },
          status: { type: "string", enum: ["passed", "failed"] },
          summary: TEXT(512),
        },
      },
    },
    findings: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "evidence"],
        properties: { summary: TEXT(512), evidence: TEXT(512) },
      },
    },
  },
} as const;

/**
 * Owner control-plane provenance for a run that predates execution-contract role routes.
 * Exactly one route per required role; the aggregate decides which route ids are registered
 * and whether the owner signed this exact canonical content.
 */
const LEGACY_ROLE_ROUTES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["repository", "runId", "expectedRevision", "roleRoutes", "approvedContentHash"],
  properties: {
    ...READ_SCHEMA.properties,
    expectedRevision: { type: "integer", minimum: 0 },
    approvedContentHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    roleRoutes: {
      type: "array",
      minItems: ROLE_KINDS.length,
      maxItems: ROLE_KINDS.length,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["role", "primary", "fallbacks"],
        properties: {
          role: { type: "string", enum: ROLE_KINDS },
          primary: TEXT(64),
          fallbacks: { type: "array", maxItems: 8, items: TEXT(64) },
        },
      },
    },
  },
} as const;

const LEGACY_EXECUTION_CONTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["repository", "runId", "expectedRevision", "body", "approvedContentHash"],
  properties: {
    ...READ_SCHEMA.properties,
    expectedRevision: { type: "integer", minimum: 0 },
    approvedContentHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    body: {
      type: "object",
      additionalProperties: false,
      required: [
        "schemaVersion", "contractId", "runId", "planDirectory", "objective",
        "mode", "reviewCadence", "phases", "slices", "dependencyEdges",
      ],
      properties: {
        schemaVersion: { type: "integer", minimum: 1 },
        contractId: TEXT(128),
        runId: TEXT(128),
        planDirectory: TEXT(256),
        objective: TEXT(2048),
        mode: { type: "string", enum: ["explorer", "expedition"] },
        reviewCadence: { type: "string", enum: ["per-slice", "per-phase", "completion-only"] },
        phases: { type: "array", items: { type: "object" } },
        slices: { type: "array", items: { type: "object" } },
        dependencyEdges: { type: "array", items: { type: "object" } },
        roleRoutes: LEGACY_ROLE_ROUTES_SCHEMA.properties.roleRoutes,
      },
    },
  },
} as const;

const TOOLS = [
  {
    name: "bearing_attach",
    description: "Recover the durable Bearing continuation for one repository and run. Read-only.",
    inputSchema: READ_SCHEMA,
  },
  {
    name: "bearing_transition",
    description: "Apply one allowed Bearing transition at an expected revision through the authenticated engine.",
    inputSchema: TRANSITION_SCHEMA,
  },
  {
    name: "bearing_handoff",
    description: "Produce the same bounded durable continuation for another agent or session. Read-only.",
    inputSchema: READ_SCHEMA,
  },
  {
    name: "bearing_focus_begin",
    description: "Open one bounded Focus run from a repository-relative request and return its immutable envelope plus the runtimeIdentity the receipt must copy verbatim.",
    inputSchema: FOCUS_BEGIN_SCHEMA,
  },
  {
    name: "bearing_focus_validate",
    description: "Validate one Focus receipt against the guard opened by bearing_focus_begin.",
    inputSchema: FOCUS_VALIDATE_SCHEMA,
  },
  {
    name: "bearing_review_context",
    description: "Read the approved contract identity, exact scope, clean candidate revision, and prior gate state for one run. Read-only.",
    inputSchema: REVIEW_CONTEXT_SCHEMA,
  },
  {
    name: "bearing_review_record",
    description: "Record one independent general or security review gate against the exact clean candidate revision.",
    inputSchema: REVIEW_RECORD_SCHEMA,
  },
  {
    name: "bearing_bind_legacy_role_routes",
    description: "Record the owner's approved role routes for a run that predates execution-contract role routes. Append-only provenance; changes no journey progress and answers no pending decision.",
    inputSchema: LEGACY_ROLE_ROUTES_SCHEMA,
  },
  {
    name: "bearing_bind_legacy_execution_contract",
    description: "Record the owner's approved execution contract for a run created before execution contracts were written to the plan directory. Append-only provenance; changes no journey progress and answers no pending decision.",
    inputSchema: LEGACY_EXECUTION_CONTRACT_SCHEMA,
  },
] as const;

/** Exactly the JSON Schema constructs the advertised tools use. Nothing wider. */
interface Rule {
  readonly type: "object" | "array" | "string" | "integer";
  readonly required?: readonly string[];
  readonly properties?: { readonly [key: string]: Rule };
  readonly items?: Rule;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly enum?: readonly string[];
  readonly pattern?: string;
}

type ReviewContextArguments = {
  readonly repository: string;
  readonly runId: string;
  readonly reviewClass: ReviewGateRequest["reviewClass"];
};
type ReviewRecordArguments = Omit<ReviewGateRequest, "reviewerSessionId">;
type LegacyRoleRouteArguments = Omit<LegacyRoleRouteRequest, "ownerSessionId">;
type LegacyExecutionContractArguments = Omit<LegacyExecutionContractRequest, "ownerSessionId">;
type TransitionArguments = {
  readonly repository: string;
  readonly runId: string;
  readonly action: HeadlessJourneyAction;
  readonly expectedRevision: number;
  readonly goal?: string;
  readonly answer?: string;
  readonly stage?: HeadlessJourneyRequest["stage"];
  readonly executionMode?: "explorer" | "expedition";
  readonly reviewCadence?: "slice" | "phase" | "end";
  readonly currentSlice?: HeadlessJourneyRequest["currentSlice"];
  readonly provider?: string;
  readonly model?: string;
  readonly reasoning?: string;
  readonly retryWarrant?: PublicRetryWarrant;
};

export interface McpDeps {
  /** Authenticated in-process transition seam; defaults to the real engine. */
  readonly headlessJourney?: (request: HeadlessJourneyRequest) => Promise<HeadlessJourneyReceipt>;
  /** In-process test seam. MCP callers never choose this durable identity. */
  readonly sessionId?: string;
}

export type McpDispatch = (request: unknown) => Promise<JsonRpcResponse | null>;

/** Validates exactly the constructs the advertised schemas use. Nothing wider. */
function schemaViolation(rule: Rule, value: unknown, label = "arguments"): string | undefined {
  if (rule.type === "object") {
    if (!isObject(value)) return `${label} must be an object`;
    for (const key of rule.required ?? []) if (!(key in value)) return `missing required property: ${key}`;
    if (rule.properties !== undefined) {
      for (const [key, entry] of Object.entries(value)) {
        const nested = rule.properties[key];
        if (nested === undefined) return `unexpected property: ${key}`;
        const violation = schemaViolation(nested, entry, key);
        if (violation !== undefined) return violation;
      }
    }
    return undefined;
  }
  if (rule.type === "array") {
    if (!Array.isArray(value)) return `${label} must be an array`;
    if (typeof rule.minItems === "number" && value.length < rule.minItems) return `${label} has too few items`;
    if (typeof rule.maxItems === "number" && value.length > rule.maxItems) return `${label} has too many items`;
    for (let index = 0; index < value.length; index += 1) {
      // A sparse or index-decorated array survives JSON.stringify as `null`; refuse it here
      // rather than letting a hole reach a bounded durable record as a valid entry.
      if (!Object.hasOwn(value, index)) return `${label} is sparse`;
      const violation = schemaViolation(rule.items!, value[index], `${label}[${index}]`);
      if (violation !== undefined) return violation;
    }
    return undefined;
  }
  if (rule.type === "integer") {
    if (!Number.isSafeInteger(value)) return `${label} must be a safe integer`;
    if (typeof rule.minimum === "number" && (value as number) < rule.minimum) return `${label} is below its minimum`;
    return undefined;
  }
  if (typeof value !== "string") return `${label} must be a string`;
  if (rule.enum !== undefined && !rule.enum.includes(value)) return `${label} is not an allowed value`;
  if (typeof rule.minLength === "number" && value.length < rule.minLength) return `${label} is too short`;
  if (typeof rule.maxLength === "number" && value.length > rule.maxLength) return `${label} is too long`;
  if (typeof rule.pattern === "string" && !new RegExp(rule.pattern).test(value)) return `${label} does not match its pattern`;
  return undefined;
}

function reply(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/** Stable, path-blind repository identity: two clients agree, neither learns the path. */
function repositoryIdentity(repositoryPath: string): string {
  return createHash("sha256").update(repositoryPath).digest("hex").slice(0, 16);
}

function toolResult(body: Record<string, unknown>, failed: boolean, modern: boolean): Record<string, unknown> {
  return {
    // A refused transition is still a *complete* result; legacy clients get no resultType at all.
    ...(modern ? { resultType: "complete" } : {}),
    structuredContent: body,
    content: [{ type: "text", text: JSON.stringify(body) }],
    ...(failed ? { isError: true } : {}),
  };
}

function rejection(runId: string, code: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: CONTINUATION_SCHEMA_VERSION,
    runId,
    revision: 0,
    code,
    allowedActions: [],
    blockers: [code],
    ...extra,
  };
}

function continuationBody(read: Extract<DurableRunContinuation, { ok: true }>): Record<string, unknown> {
  const { projection, verification } = read;
  return {
    schemaVersion: CONTINUATION_SCHEMA_VERSION,
    repository: repositoryIdentity(read.repositoryPath),
    runId: read.runId,
    objective: read.objective,
    revision: read.revision,
    updatedAt: read.updatedAt,
    ...(read.stage ? { stage: read.stage } : {}),
    ...(read.status ? { status: read.status } : {}),
    allowedActions: projection.allowedActions ?? [],
    // A recovery transition is only advertised if the caller can also name it: the engine
    // accepts exactly one stage for a saved failed route and refuses every other one, so
    // publishing the action without its stage would advertise a move nobody can make.
    ...(projection.recoveryAction ? { recoveryAction: projection.recoveryAction } : {}),
    ...(projection.requiredOwnerAction
      ? { requiredOwnerAction: projection.requiredOwnerAction }
      : read.roleRoutesBlocker
        ? { requiredOwnerAction: read.roleRoutesBlocker }
        : {}),
    ...(projection.question ? { question: projection.question } : {}),
    ...(projection.summary ? { summary: projection.summary } : {}),
    ...(projection.outcome ? { outcome: projection.outcome } : {}),
    ...(read.planDirectory ? { planDirectory: read.planDirectory } : {}),
    ...(read.workspace ? { workspace: read.workspace } : {}),
    ...(read.runPath ? { runPath: read.runPath } : {}),
    ...(read.checkpoint ? { checkpoint: read.checkpoint } : {}),
    ...(read.selection ? { route: read.selection } : {}),
    ...(read.roleRoutes ? { roleRoutes: read.roleRoutes } : {}),
    slices: {
      completed: verification?.completedSlices?.map((slice) => slice.sliceId) ?? [],
      reviewed: verification?.reviewedSliceIds ?? [],
    },
    ...(verification
      ? {
        verification: {
          layer: verification.layer,
          verdict: verification.verdict,
          ...(verification.findingCount === undefined ? {} : { findingCount: verification.findingCount }),
        },
      }
      : {}),
    evidence: projection.artifacts ?? [],
    blockers: read.blockers,
    continuity: read.continuity,
  };
}

/** One read-only continuation. `bearing_attach` and `bearing_handoff` are the same read. */
async function continuation(repository: string, runId: string): Promise<Record<string, unknown>> {
  const read = await readDurableContinuation(repository, runId);
  if (read.ok) return continuationBody(read);
  return read.code === "run_not_found"
    ? {
      schemaVersion: CONTINUATION_SCHEMA_VERSION,
      runId,
      revision: 0,
      code: "run_not_found",
      allowedActions: ["create"],
      blockers: [],
      ...(read.repositoryPath ? { repository: repositoryIdentity(read.repositoryPath) } : {}),
    }
    : rejection(runId, read.code);
}

type LockOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

/**
 * Serialize competing MCP writers across processes with one atomic exclusive create.
 * A repository with no `.bearing` yet has no durable run to race over, and the workspace
 * bootstrap already fails closed on a concurrent initialization.
 */
async function withRunLock<T>(
  repositoryPath: string,
  runId: string,
  operation: () => Promise<T>,
): Promise<LockOutcome<T>> {
  let pinned: PinnedWorkspaceRoot | undefined;
  try {
    pinned = await pinWorkspaceRoot(repositoryPath);
  } catch (error) {
    if (isWorkspaceRootError(error)) {
      throw error;
    }
  }

  const path = await lockPath(pinned?.repositoryPath ?? repositoryPath, runId);

  let handle: FileHandle | undefined;
  for (let attempt = 0; attempt < 2 && handle === undefined; attempt += 1) {
    try {
      if (pinned) await assertWorkspaceRoot(pinned);
      handle = await open(path, "wx");
    } catch (error) {
      if (isWorkspaceRootError(error)) throw error;
      const code = isObject(error) ? error.code : undefined;
      if (code === "ENOENT") return { ok: true, value: await operation() };
      if (code !== "EEXIST" || attempt > 0) return { ok: false };
      const held = await stat(path).catch(() => undefined);
      if (held !== undefined && Date.now() - held.mtimeMs < LOCK_STALE_MS) return { ok: false };
      if (pinned) await assertWorkspaceRoot(pinned);
      await rm(path, { force: true }).catch(() => undefined);
    }
  }
  if (handle === undefined) return { ok: false };
  try {
    await handle.write(`${process.pid}\n`);
    return { ok: true, value: await operation() };
  } finally {
    await handle.close().catch(() => undefined);
    if (pinned) await assertWorkspaceRoot(pinned);
    await rm(path, { force: true }).catch(() => undefined);
  }
}

function guard(
  read: DurableRunContinuation,
  args: TransitionArguments,
): Record<string, unknown> | undefined {
  if (!read.ok && read.code !== "run_not_found") return rejection(args.runId, read.code);
  const revision = read.ok ? read.revision : 0;
  if (args.expectedRevision !== revision) {
    return { ...rejection(args.runId, "stale_revision"), revision };
  }
  const allowed = read.ok ? read.projection.allowedActions ?? [] : ["create"];
  if (!allowed.includes(args.action)) {
    return { ...rejection(args.runId, "action_not_allowed"), revision, allowedActions: allowed };
  }
  const recovery = read.ok ? read.projection.recoveryAction : undefined;
  if (args.retryWarrant !== undefined && args.action === "progress" && !(recovery?.type === "progress" && recovery.retryWarrants !== undefined)) {
    return { ...rejection(args.runId, "retry_warrant_not_applicable"), revision };
  }
  if (args.action === "progress" && recovery?.type === "progress" && recovery.retryWarrants !== undefined) {
    if (args.stage !== recovery.stage) {
      return { ...rejection(args.runId, "recovery_stage_mismatch"), revision, recoveryAction: recovery };
    }
    if (args.retryWarrant !== undefined && !recovery.retryWarrants.includes(args.retryWarrant)) {
      return { ...rejection(args.runId, "retry_warrant_required"), revision, recoveryAction: recovery };
    }
  }
  return undefined;
}

async function transition(args: TransitionArguments, deps: McpDeps, sessionId: string): Promise<Record<string, unknown>> {
  try {
    const read = await readDurableContinuation(args.repository, args.runId);
    const blocked = guard(read, args);
    if (blocked) return blocked;
    if (args.retryWarrant !== undefined && args.action !== "progress") {
      return { ...rejection(args.runId, "retry_warrant_unsupported"), revision: read.ok ? read.revision : 0 };
    }
    // Status is a read, gated like a write: past the guard it is the same continuation
    // `bearing_attach` returns, with no route, no lock, and no engine.
    if (args.action === "status") return continuation(args.repository, args.runId);
    const repositoryPath = read.repositoryPath;
    if (repositoryPath === undefined) return rejection(args.runId, "repository_rejected");
    const suppliedRouteFields = [args.provider, args.model, args.reasoning].filter((value) => value !== undefined).length;
    if (suppliedRouteFields !== 0 && suppliedRouteFields !== 3) {
      return { ...rejection(args.runId, "route_incomplete"), revision: read.ok ? read.revision : 0 };
    }
    // A complete route on an exact-revision transition is the owner's current selection.
    // This is also the public recovery path for replacing a failed or unavailable saved route;
    // the journey checkpoint written by the transition makes the new selection durable.
    const route = suppliedRouteFields === 3
      ? { provider: args.provider!, model: args.model!, reasoning: args.reasoning! }
      : read.ok ? read.selection : undefined;
    if (!route) return rejection(args.runId, "route_unspecified");

    const locked = await withRunLock(repositoryPath, args.runId, async () => {
      // Re-read under the lock: a writer that won the race has already moved the revision.
      const current = await readDurableContinuation(args.repository, args.runId);
      const stale = guard(current, args);
      if (stale) return { blocked: stale };
      const run = deps.headlessJourney ?? ((request: HeadlessJourneyRequest) =>
        executeHeadlessJourney(request, { processRunner: new NodeProcessRunner() }));
      const receipt = await run({
        action: args.action,
        repository: repositoryPath,
        provider: route.provider,
        model: route.model,
        reasoning: route.reasoning,
        runId: args.runId,
        sessionId,
        expectedRevision: args.expectedRevision,
        ...(args.goal ? { goal: args.goal } : {}),
        ...(args.answer ? { answer: args.answer } : {}),
        ...(args.stage ? { stage: args.stage } : {}),
        ...(args.executionMode ? { executionMode: args.executionMode } : {}),
        ...(args.reviewCadence ? { reviewCadence: args.reviewCadence } : {}),
        ...(args.currentSlice ? { currentSlice: args.currentSlice } : {}),
        ...(args.retryWarrant ? { retryWarrant: args.retryWarrant } : {}),
      });
      return { receipt };
    });
    if (!locked.ok) return rejection(args.runId, "run_busy");
    const { blocked: lost, receipt } = locked.value;
    if (lost || !receipt) return lost ?? rejection(args.runId, "transition_unavailable");

    const fresh = await continuation(args.repository, args.runId);
    return receipt.ok ? fresh : { ...fresh, code: receipt.code ?? "transition_unavailable" };
  } catch (error) {
    if (isWorkspaceRootError(error) || (isObject(error) && (error as { code?: string }).code === "workspace_root_changed")) {
      return rejection(args.runId, "workspace_root_changed");
    }
    throw error;
  }
}

function refusal(code: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: CONTINUATION_SCHEMA_VERSION, code, ...extra };
}

/** Open one Focus guard through the existing standalone logic. No provider, no CLI. */
async function focusBegin(repository: string, requestPath: string): Promise<Record<string, unknown>> {
  try {
    const repositoryPath = await admitRepositoryRoot(repository);
    if (repositoryPath === undefined) return refusal("repository_rejected");
    const begun = await beginStandaloneFocus(repositoryPath, requestPath);
    if (!begun.ok) {
      return refusal(begun.reason, {
        ...("sliceId" in begun && begun.sliceId ? { sliceId: begun.sliceId } : {}),
        ...("field" in begun && begun.field ? { field: begun.field } : {}),
        ...("detail" in begun && begun.detail ? { detail: begun.detail } : {}),
      });
    }
    return {
      schemaVersion: CONTINUATION_SCHEMA_VERSION,
      repository: repositoryIdentity(repositoryPath),
      focusRunId: begun.runId,
      envelope: begun.envelope,
      // The immutable identity of the runtime that will validate this run; the
      // receipt must be bound to it or validation refuses with runtime_mismatch.
      runtimeIdentity: begun.runtimeIdentity,
    };
  } catch (error) {
    if (isWorkspaceRootError(error) || (isObject(error) && (error as { code?: string }).code === "workspace_root_changed")) {
      return refusal("workspace_root_changed");
    }
    throw error;
  }
}

async function focusValidate(repository: string, focusRunId: string, receiptPath: string): Promise<Record<string, unknown>> {
  try {
    const repositoryPath = await admitRepositoryRoot(repository);
    if (repositoryPath === undefined) return refusal("repository_rejected");
    const result = await validateStandaloneFocus(repositoryPath, focusRunId, receiptPath);
    return result.ok
      ? {
        schemaVersion: CONTINUATION_SCHEMA_VERSION,
        repository: repositoryIdentity(repositoryPath),
        changedPaths: result.changedPaths,
      }
      : refusal(result.reason);
  } catch (error) {
    if (isWorkspaceRootError(error) || (isObject(error) && (error as { code?: string }).code === "workspace_root_changed")) {
      return refusal("workspace_root_changed");
    }
    throw error;
  }
}

async function reviewContext(args: ReviewContextArguments): Promise<Record<string, unknown>> {
  try {
    const read = await readReviewContext(args.repository, args.runId, args.reviewClass);
    if (!read.ok) return refusal(read.code, { runId: args.runId });
    const { ok: _admitted, repositoryPath, reviewRouteBlocker, ...projected } = read;
    return {
      schemaVersion: CONTINUATION_SCHEMA_VERSION,
      repository: repositoryIdentity(repositoryPath),
      ...projected,
      ...(reviewRouteBlocker ? { requiredOwnerAction: reviewRouteBlocker } : {}),
    };
  } catch (error) {
    if (isWorkspaceRootError(error) || (isObject(error) && (error as { code?: string }).code === "workspace_root_changed")) {
      return refusal("workspace_root_changed", { runId: args.runId });
    }
    throw error;
  }
}

/**
 * One review gate, serialized against every other MCP writer on the run. The
 * record itself is decided inside the lock so a concurrent writer that advanced
 * the revision is refused rather than certifying a candidate it never saw.
 */
async function reviewRecord(args: ReviewRecordArguments, reviewerSessionId: string): Promise<Record<string, unknown>> {
  try {
    const repositoryPath = await admitRepositoryRoot(args.repository);
    if (repositoryPath === undefined) return refusal("repository_rejected", { runId: args.runId });
    const locked = await withRunLock(repositoryPath, args.runId, () => recordReviewGate({ ...args, reviewerSessionId }));
    if (!locked.ok) return refusal("run_busy", { runId: args.runId });
    const result = locked.value;
    return result.ok
      ? {
        schemaVersion: CONTINUATION_SCHEMA_VERSION,
        repository: repositoryIdentity(repositoryPath),
        runId: args.runId,
        revision: result.revision,
        recorded: result.recorded,
        review: result.record,
      }
      : refusal(result.code, { runId: args.runId, ...(result.revision === undefined ? {} : { revision: result.revision }) });
  } catch (error) {
    if (isWorkspaceRootError(error) || (isObject(error) && (error as { code?: string }).code === "workspace_root_changed")) {
      return refusal("workspace_root_changed", { runId: args.runId });
    }
    throw error;
  }
}

/**
 * One owner role-route binding, serialized against every other MCP writer on the run so a
 * concurrent writer that advanced the revision is refused rather than bound behind its back.
 */
async function bindLegacyRoleRoutes(args: LegacyRoleRouteArguments, ownerSessionId: string): Promise<Record<string, unknown>> {
  try {
    const repositoryPath = await admitRepositoryRoot(args.repository);
    if (repositoryPath === undefined) return refusal("repository_rejected", { runId: args.runId });
    const locked = await withRunLock(repositoryPath, args.runId, () => applyLegacyRoleRouteApproval({ ...args, ownerSessionId }));
    if (!locked.ok) return refusal("run_busy", { runId: args.runId });
    const result = locked.value;
    return result.ok
      ? {
        schemaVersion: CONTINUATION_SCHEMA_VERSION,
        repository: repositoryIdentity(repositoryPath),
        runId: args.runId,
        revision: result.revision,
        recorded: result.recorded,
        roleRoutes: result.roleRoutes,
      }
      : refusal(result.code, { runId: args.runId, ...(result.revision === undefined ? {} : { revision: result.revision }) });
  } catch (error) {
    if (isWorkspaceRootError(error) || (isObject(error) && (error as { code?: string }).code === "workspace_root_changed")) {
      return refusal("workspace_root_changed", { runId: args.runId });
    }
    throw error;
  }
}

/** Every advertised tool is routed by name. An unrouted name refuses rather than falling through to a read. */
function toolBody(
  name: (typeof TOOLS)[number]["name"],
  input: Record<string, unknown>,
  deps: McpDeps,
  sessionId: string,
): Promise<Record<string, unknown>> {
  switch (name) {
    case "bearing_attach":
    case "bearing_handoff":
      return continuation(input.repository as string, input.runId as string);
    case "bearing_transition":
      return transition(input as unknown as TransitionArguments, deps, sessionId);
    case "bearing_focus_begin":
      return focusBegin(input.repository as string, input.requestPath as string);
    case "bearing_focus_validate":
      return focusValidate(input.repository as string, input.focusRunId as string, input.receiptPath as string);
    case "bearing_review_context":
      return reviewContext(input as unknown as ReviewContextArguments);
    case "bearing_review_record":
      return reviewRecord(input as unknown as ReviewRecordArguments, sessionId);
    case "bearing_bind_legacy_role_routes":
      return bindLegacyRoleRoutes(input as unknown as LegacyRoleRouteArguments, sessionId);
    case "bearing_bind_legacy_execution_contract":
      return bindLegacyExecutionContract(input as unknown as LegacyExecutionContractArguments, sessionId);
  }
}

async function bindLegacyExecutionContract(args: LegacyExecutionContractArguments, ownerSessionId: string): Promise<Record<string, unknown>> {
  try {
    const repositoryPath = await admitRepositoryRoot(args.repository);
    if (repositoryPath === undefined) return refusal("repository_rejected", { runId: args.runId });
    const locked = await withRunLock(repositoryPath, args.runId, () => applyLegacyExecutionContractApproval({ ...args, ownerSessionId }));
    if (!locked.ok) return refusal("run_busy", { runId: args.runId });
    const result = locked.value;
    return result.ok
      ? {
        schemaVersion: CONTINUATION_SCHEMA_VERSION,
        repository: repositoryIdentity(repositoryPath),
        runId: args.runId,
        revision: result.revision,
        recorded: result.recorded,
        contract: result.contract,
      }
      : refusal(result.code, { runId: args.runId, ...(result.revision === undefined ? {} : { revision: result.revision }) });
  } catch (error) {
    if (isWorkspaceRootError(error) || (isObject(error) && (error as { code?: string }).code === "workspace_root_changed")) {
      return refusal("workspace_root_changed", { runId: args.runId });
    }
    throw error;
  }
}

export function createDispatcher(deps: McpDeps = {}): McpDispatch {
  const sessionId = deps.sessionId ?? randomUUID();
  return async (request: unknown): Promise<JsonRpcResponse | null> => {
    if (!isObject(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      return rpcError(null, -32600, "Invalid Request");
    }
    const rawId = request.id;
    const notification = rawId === undefined;
    const id: JsonRpcId = typeof rawId === "string" || typeof rawId === "number" ? rawId : null;
    if (!notification && rawId !== null && typeof rawId !== "string" && typeof rawId !== "number") {
      return rpcError(null, -32600, "Invalid Request");
    }
    const params = isObject(request.params) ? request.params : undefined;
    if (request.params !== undefined && params === undefined) {
      return notification ? null : rpcError(id, -32602, "Invalid params");
    }

    // Era is a property of the request, not of the connection: the modern version arrives only in
    // namespaced `_meta`, the legacy one only in the `initialize` handshake. `server/discover`
    // has no legacy counterpart, so it is modern whether or not the caller announced itself.
    const meta = isObject(params?._meta) ? params._meta as Record<string, unknown> : undefined;
    const declared = meta?.[PROTOCOL_VERSION_META];
    const version = declared ?? (request.method === "initialize" ? params?.protocolVersion : undefined);
    if (version !== undefined && !MCP_PROTOCOL_VERSIONS.includes(version as never)) {
      return notification ? null : rpcError(id, UNSUPPORTED_PROTOCOL, "Unsupported protocol version", {
        supported: [...MCP_PROTOCOL_VERSIONS],
        requested: String(version),
      });
    }
    const modern = request.method === "server/discover" || declared !== undefined;

    const respond = (result: unknown): JsonRpcResponse | null => (notification ? null : reply(id, result));
    const fail = (code: number, message: string, data?: unknown): JsonRpcResponse | null =>
      (notification ? null : rpcError(id, code, message, data));

    switch (request.method) {
      case "initialize":
        return respond({
          protocolVersion: typeof version === "string" ? version : MCP_PROTOCOL_VERSIONS[0],
          serverInfo: SERVER_INFO,
          capabilities: { tools: {} },
        });
      case "server/discover":
        return respond({
          resultType: "complete",
          supportedVersions: [...MCP_PROTOCOL_VERSIONS],
          capabilities: { tools: {} },
          _meta: { [SERVER_INFO_META]: SERVER_INFO },
        });
      case "notifications/initialized":
        return null;
      case "tools/list":
        return respond({ ...(modern ? { resultType: "complete" } : {}), tools: TOOLS });
      case "tools/call": {
        const name = params?.name;
        const tool = TOOLS.find((candidate) => candidate.name === name);
        if (!tool) return fail(-32602, "Unknown tool");
        const args = params?.arguments ?? {};
        const violation = schemaViolation(tool.inputSchema, args);
        if (violation !== undefined) return fail(-32602, "Invalid tool arguments", { violation });
        const body = await toolBody(tool.name, args as Record<string, unknown>, deps, sessionId);
        return respond(toolResult(body, typeof body.code === "string", modern));
      }
      default:
        return fail(-32601, "Method not found");
    }
  };
}

/**
 * Newline-delimited JSON-RPC over stdio. Responses stay in request order, oversized and
 * unparsable lines are typed rather than fatal, notifications produce nothing, and EOF ends
 * the loop. Nothing but protocol frames is ever written.
 */
export function serveStdio(
  handle: McpDispatch,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  return new Promise<void>((finish) => {
    let buffer = "";
    let discarding = false;
    let queue: Promise<void> = Promise.resolve();
    const enqueue = (task: () => Promise<JsonRpcResponse | null>): void => {
      queue = queue.then(task).then(
        (response) => { if (response) output.write(`${JSON.stringify(response)}\n`); },
        () => undefined,
      );
    };
    const oversized = (): Promise<JsonRpcResponse> =>
      Promise.resolve(rpcError(null, -32600, "Request line exceeds the stdio bound"));
    const line = (value: string): void => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return;
      if (trimmed.length > MAX_STDIO_LINE) { enqueue(oversized); return; }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        enqueue(() => Promise.resolve(rpcError(null, -32700, "Parse error")));
        return;
      }
      enqueue(() => handle(parsed));
    };

    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      buffer += chunk;
      for (let index = buffer.indexOf("\n"); index !== -1; index = buffer.indexOf("\n")) {
        const value = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (discarding) discarding = false;
        else line(value);
      }
      if (buffer.length > MAX_STDIO_LINE) {
        buffer = "";
        discarding = true;
        enqueue(oversized);
      }
    });
    let ended = false;
    const end = (): void => {
      if (ended) return;
      ended = true;
      if (!discarding) line(buffer);
      buffer = "";
      queue.then(() => finish(), () => finish());
    };
    input.on("end", end);
    input.on("close", end);
    input.on("error", end);
  });
}
