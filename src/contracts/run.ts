/**
 * Schema-v1 command/event contracts for a Bearing run.
 *
 * Only the MVP transitions needed for IT-2 are modeled: create a work request,
 * require a consequential owner decision, and record an owner answer. Provider,
 * execution, and report behavior are deliberately absent.
 *
 * Validation is hand-written at this boundary; no JSON Schema dependency is
 * introduced. TypeScript discriminated unions are the source of truth for
 * server logic.
 */
import { createHash } from "node:crypto";

export const COMMAND_SCHEMA_VERSION = 1 as const;
export const EVENT_SCHEMA_VERSION = 1 as const;
const MAX_QA_JSON_BYTES = 640 * 1024;
const MAX_JOURNEY_RESULT_JSON = 640 * 1024;

/** Local browser session reference. `actor` is the authority role. */
export interface SessionRef {
  readonly sessionId: string;
  readonly actor: string;
}

// --- Command payload shapes -------------------------------------------------

export interface CreateWorkRequestPayload {
  readonly title: string;
  readonly goal: string;
}

/** `consequential` is fixed true: only consequential decisions gate the run. */
export interface RequireDecisionPayload {
  readonly decisionId: string;
  readonly question: string;
  readonly consequential: true;
}

export interface RecordOwnerAnswerPayload {
  readonly decisionId: string;
  readonly answer: string;
}

/** Inputs, not asserted estimates: the aggregate derives the recorded recommendation. */
export interface RecommendExecutionModePayload {
  readonly workItems: number;
  readonly maxCrewmatesPerExplorer: number;
  readonly perAgentTokenEstimate: number;
}

export interface ApproveExecutionModePayload {
  readonly recommendationEventId: string;
}

export interface OverrideExecutionModePayload {
  readonly recommendationEventId: string;
  readonly selectedMode: "explorer" | "expedition";
}

export interface RecordJourneyCheckpointPayload {
  readonly stage: "set-bearings" | "gather-supplies" | "map-route" | "draft-implementation" | "execute-explorer" | "execute-expedition" | "review";
  readonly status: "running" | "waiting" | "stopped" | "failed" | "complete";
  readonly artifacts: readonly string[];
  readonly planDirectory?: string;
  readonly question?: string;
  readonly questionDecisionId?: string;
  readonly reviewBaselineRevision?: number;
  readonly lastResultJson?: string;
  readonly qaJson?: string;
  readonly gatherQuestionsDiscovered?: boolean;
  readonly selectionProvider?: string;
  readonly selectionModel?: string;
  readonly selectionReasoning?: string;
}

// --- Command envelope (discriminated by `type`) ----------------------------

interface CommandEnvelopeBase {
  readonly schemaVersion: typeof COMMAND_SCHEMA_VERSION;
  readonly commandId: string;
  readonly runId: string;
  readonly expectedRevision: number;
  readonly session: SessionRef;
  readonly correlationId: string;
}

export interface CreateWorkRequestCommand extends CommandEnvelopeBase {
  readonly type: "createWorkRequest";
  readonly payload: CreateWorkRequestPayload;
}

export interface RequireDecisionCommand extends CommandEnvelopeBase {
  readonly type: "requireDecision";
  readonly payload: RequireDecisionPayload;
}

export interface RecordOwnerAnswerCommand extends CommandEnvelopeBase {
  readonly type: "recordOwnerAnswer";
  readonly payload: RecordOwnerAnswerPayload;
}

export interface RecommendExecutionModeCommand extends CommandEnvelopeBase {
  readonly type: "recommendExecutionMode";
  readonly payload: RecommendExecutionModePayload;
}

export interface ApproveExecutionModeCommand extends CommandEnvelopeBase {
  readonly type: "approveExecutionMode";
  readonly payload: ApproveExecutionModePayload;
}

export interface OverrideExecutionModeCommand extends CommandEnvelopeBase {
  readonly type: "overrideExecutionMode";
  readonly payload: OverrideExecutionModePayload;
}

export interface RecordJourneyCheckpointCommand extends CommandEnvelopeBase {
  readonly type: "recordJourneyCheckpoint";
  readonly payload: RecordJourneyCheckpointPayload;
}

export type CommandEnvelopeV1 =
  | CreateWorkRequestCommand
  | RequireDecisionCommand
  | RecordOwnerAnswerCommand
  | RecommendExecutionModeCommand
  | ApproveExecutionModeCommand
  | OverrideExecutionModeCommand
  | RecordJourneyCheckpointCommand;

export type CommandType = CommandEnvelopeV1["type"];

// --- Event envelope ---------------------------------------------------------

export type EventType = "workRequestCreated" | "decisionRequired" | "ownerAnswered" | "executionModeRecommended" | "executionModeApproved" | "executionModeOverridden" | "journeyCheckpointRecorded";

export interface EventEnvelopeV1 {
  readonly schemaVersion: typeof EVENT_SCHEMA_VERSION;
  readonly eventId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly recordedAt: string;
  readonly type: EventType;
  readonly actor: string;
  readonly sessionId: string;
  readonly correlationId: string;
  /** Command id that caused this event. */
  readonly causationId: string;
  /** Hash of the accepted command body, excluding its dedupe key. */
  readonly commandContentHash: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly evidenceRefs: readonly string[];
  /** Hash of the previous event in the run; "" for the first event. */
  readonly previousHash: string;
  /** sha256 over the canonical event body excluding this field. */
  readonly hash: string;
}

// --- Boundary validation ----------------------------------------------------

export type ParseFailure = "malformed" | "future_schema";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: ParseFailure };

const SCHEMA_VERSION_MAX = COMMAND_SCHEMA_VERSION;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_STRING = 4096;
const MAX_EVIDENCE_REFS = 64;
export const MAX_RECOMMENDATION_WORK_ITEMS = 64;
export const MAX_RECOMMENDATION_CREWMATES = 16;
export const MAX_RECOMMENDATION_TOKENS = 100_000;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown, max = MAX_STRING): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}

function isId(v: unknown): v is string {
  return typeof v === "string" && ID_RE.test(v);
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
}

function isSessionRef(v: unknown): v is SessionRef {
  if (!isObject(v)) return false;
  return isId(v.sessionId) && isNonEmptyString(v.actor, 64);
}

function isReadonlyStringArray(v: unknown): v is readonly string[] {
  if (!Array.isArray(v)) return false;
  if (v.length > MAX_EVIDENCE_REFS) return false;
  return v.every((entry) => typeof entry === "string" && entry.length <= MAX_STRING);
}

function isHash(v: unknown): v is string {
  return typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
}

/** True if `v` is a syntactically valid v1 envelope of any command type. */
export function parseCommandEnvelope(v: unknown): ParseResult<CommandEnvelopeV1> {
  if (!isObject(v)) return { ok: false, reason: "malformed" };
  if (v.schemaVersion !== COMMAND_SCHEMA_VERSION) {
    if (typeof v.schemaVersion === "number" && v.schemaVersion > SCHEMA_VERSION_MAX) {
      return { ok: false, reason: "future_schema" };
    }
    return { ok: false, reason: "malformed" };
  }
  if (
    !isId(v.commandId) ||
    !isId(v.runId) ||
    !isNonNegativeInt(v.expectedRevision) ||
    !isSessionRef(v.session) ||
    !isId(v.correlationId)
  ) {
    return { ok: false, reason: "malformed" };
  }
  switch (v.type) {
    case "createWorkRequest":
      if (!isCreateWorkRequestPayload(v.payload)) return { ok: false, reason: "malformed" };
      break;
    case "requireDecision":
      if (!isRequireDecisionPayload(v.payload)) return { ok: false, reason: "malformed" };
      break;
    case "recordOwnerAnswer":
      if (!isRecordOwnerAnswerPayload(v.payload)) return { ok: false, reason: "malformed" };
      break;
    case "recommendExecutionMode":
      if (!isRecommendExecutionModePayload(v.payload)) return { ok: false, reason: "malformed" };
      break;
    case "approveExecutionMode":
      if (!isApproveExecutionModePayload(v.payload)) return { ok: false, reason: "malformed" };
      break;
    case "overrideExecutionMode":
      if (!isOverrideExecutionModePayload(v.payload)) return { ok: false, reason: "malformed" };
      break;
    case "recordJourneyCheckpoint":
      if (!isRecordJourneyCheckpointPayload(v.payload)) return { ok: false, reason: "malformed" };
      break;
    default:
      return { ok: false, reason: "malformed" };
  }
  return { ok: true, value: v as unknown as CommandEnvelopeV1 };
}

function isCreateWorkRequestPayload(v: unknown): v is CreateWorkRequestPayload {
  if (!isObject(v)) return false;
  return isNonEmptyString(v.title) && isNonEmptyString(v.goal);
}

function isRequireDecisionPayload(v: unknown): v is RequireDecisionPayload {
  if (!isObject(v)) return false;
  return (
    isId(v.decisionId) &&
    isNonEmptyString(v.question) &&
    v.consequential === true
  );
}

function isRecordOwnerAnswerPayload(v: unknown): v is RecordOwnerAnswerPayload {
  if (!isObject(v)) return false;
  return isId(v.decisionId) && isNonEmptyString(v.answer);
}

function isPositiveInt(v: unknown): v is number {
  return isNonNegativeInt(v) && v > 0;
}

function isRecommendExecutionModePayload(v: unknown): v is RecommendExecutionModePayload {
  return hasExactKeys(v, ["workItems", "maxCrewmatesPerExplorer", "perAgentTokenEstimate"])
    && isPositiveInt(v.workItems) && v.workItems <= MAX_RECOMMENDATION_WORK_ITEMS
    && isPositiveInt(v.maxCrewmatesPerExplorer) && v.maxCrewmatesPerExplorer <= MAX_RECOMMENDATION_CREWMATES
    && isPositiveInt(v.perAgentTokenEstimate) && v.perAgentTokenEstimate <= MAX_RECOMMENDATION_TOKENS;
}

function isApproveExecutionModePayload(v: unknown): v is ApproveExecutionModePayload {
  return hasExactKeys(v, ["recommendationEventId"]) && isId(v.recommendationEventId);
}

function isOverrideExecutionModePayload(v: unknown): v is OverrideExecutionModePayload {
  return hasExactKeys(v, ["recommendationEventId", "selectedMode"]) && isId(v.recommendationEventId) && (v.selectedMode === "explorer" || v.selectedMode === "expedition");
}

function isRecordJourneyCheckpointPayload(v: unknown): v is RecordJourneyCheckpointPayload {
  if (!isObject(v) || !["stage", "status", "artifacts"].every((key) => key in v) || Object.keys(v).some((key) => !["stage", "status", "artifacts", "planDirectory", "question", "questionDecisionId", "reviewBaselineRevision", "lastResultJson", "qaJson", "gatherQuestionsDiscovered", "selectionProvider", "selectionModel", "selectionReasoning"].includes(key))) return false;
  const stages = ["set-bearings", "gather-supplies", "map-route", "draft-implementation", "execute-explorer", "execute-expedition", "review"];
  const statuses = ["running", "waiting", "stopped", "failed", "complete"];
  const selectionValues = [v.selectionProvider, v.selectionModel, v.selectionReasoning];
  const selectionValid = selectionValues.every((value) => value === undefined) || selectionValues.every((value) => isNonEmptyString(value, 256));
  return stages.includes(v.stage as string) && statuses.includes(v.status as string) && Array.isArray(v.artifacts) && v.artifacts.length <= 256 && v.artifacts.every((path) => isNonEmptyString(path)) &&
    (v.planDirectory === undefined || isNonEmptyString(v.planDirectory)) && (v.question === undefined || isNonEmptyString(v.question)) && (v.questionDecisionId === undefined || (isId(v.questionDecisionId) && v.question !== undefined)) &&
    (v.reviewBaselineRevision === undefined || isNonNegativeInt(v.reviewBaselineRevision)) && (v.lastResultJson === undefined || isNonEmptyString(v.lastResultJson, MAX_JOURNEY_RESULT_JSON)) &&
    (v.qaJson === undefined || isNonEmptyString(v.qaJson, MAX_QA_JSON_BYTES)) && (v.gatherQuestionsDiscovered === undefined || typeof v.gatherQuestionsDiscovered === "boolean") && selectionValid;
}

function hasExactKeys(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  return isObject(v) && Object.keys(v).length === keys.length && keys.every((key) => key in v);
}

/** True if `v` is a syntactically valid v1 event envelope. */
export function parseEventEnvelope(v: unknown): ParseResult<EventEnvelopeV1> {
  if (!isObject(v)) return { ok: false, reason: "malformed" };
  if (v.schemaVersion !== EVENT_SCHEMA_VERSION) {
    if (typeof v.schemaVersion === "number" && v.schemaVersion > EVENT_SCHEMA_VERSION) {
      return { ok: false, reason: "future_schema" };
    }
    return { ok: false, reason: "malformed" };
  }
  if (
    !isId(v.eventId) ||
    !isId(v.runId) ||
    !isNonNegativeInt(v.sequence) ||
    !isNonEmptyString(v.recordedAt) ||
    !isNonEmptyString(v.actor, 64) ||
    !isId(v.sessionId) ||
    !isId(v.correlationId) ||
    !isId(v.causationId) ||
    !isHash(v.commandContentHash) ||
    !isObject(v.payload) ||
    !isReadonlyStringArray(v.evidenceRefs) ||
    !(v.previousHash === "" || isHash(v.previousHash)) ||
    !isHash(v.hash)
  ) {
    return { ok: false, reason: "malformed" };
  }
  switch (v.type) {
    case "workRequestCreated":
      if (!isCreateWorkRequestPayload(v.payload)) return { ok: false, reason: "malformed" };
      break;
    case "decisionRequired":
      if (!isRequireDecisionPayload(v.payload)) return { ok: false, reason: "malformed" };
      break;
    case "ownerAnswered":
      if (!isRecordOwnerAnswerPayload(v.payload)) return { ok: false, reason: "malformed" };
      break;
    case "executionModeRecommended":
      if (!isExecutionModeRecommendationPayload(v.payload)) return { ok: false, reason: "malformed" };
      break;
    case "executionModeApproved":
      if (!isExecutionModeApprovalPayload(v.payload, false)) return { ok: false, reason: "malformed" };
      break;
    case "executionModeOverridden":
      if (!isExecutionModeApprovalPayload(v.payload, true)) return { ok: false, reason: "malformed" };
      break;
    case "journeyCheckpointRecorded":
      if (!isRecordJourneyCheckpointPayload(v.payload)) return { ok: false, reason: "malformed" };
      break;
    default:
      return { ok: false, reason: "malformed" };
  }
  return { ok: true, value: v as unknown as EventEnvelopeV1 };
}

function isMode(v: unknown): v is "explorer" | "expedition" {
  return v === "explorer" || v === "expedition";
}

function isExecutionModeRecommendationPayload(v: unknown): boolean {
  if (!isObject(v)) return false;
  const record = v;
  return Object.keys(record).length === 10 && ["workItems", "maxCrewmatesPerExplorer", "perAgentTokenEstimate", "recommendedMode", "selectedMode", "overridden", "estimatedAgents", "estimatedTokens", "tradeoffs", "launchAuthorized"].every((key) => key in record)
    && isPositiveInt(record.workItems) && isPositiveInt(record.maxCrewmatesPerExplorer) && isPositiveInt(record.perAgentTokenEstimate)
    && isMode(record.recommendedMode) && isMode(record.selectedMode)
    && typeof record.overridden === "boolean" && isPositiveInt(record.estimatedAgents) && isPositiveInt(record.estimatedTokens)
    && record.launchAuthorized === false && isObject(record.tradeoffs)
    && isNonEmptyString(record.tradeoffs.tokens) && isNonEmptyString(record.tradeoffs.coordination)
    && record.overridden === (record.selectedMode !== record.recommendedMode);
}

function isExecutionModeApprovalPayload(v: unknown, overridden: boolean): boolean {
  return hasExactKeys(v, ["recommendationEventId", "selectedMode", "overridden"]) && isId(v.recommendationEventId) && isMode(v.selectedMode) && v.overridden === overridden;
}

// --- Hashing (deterministic; supports chain integrity, not external claims) -

/** Stable stringification: object keys sorted ascending at every depth. */
export function canonicalStringify(value: unknown): string {
  return _stringify(value);
}

function _stringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(_stringify).join(",")}]`;
  }
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${_stringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Content hash of a command envelope, excluding `commandId` (the dedupe key).
 * Two envelopes with the same commandId and same content hash are idempotent.
 */
export function hashCommand(command: CommandEnvelopeV1): string {
  const { commandId: _omit, ...rest } = command;
  return sha256(canonicalStringify(rest));
}

/** Hash of an event envelope over all fields except `hash`. */
export function hashEvent(event: Omit<EventEnvelopeV1, "hash">): string {
  return sha256(canonicalStringify(event));
}
