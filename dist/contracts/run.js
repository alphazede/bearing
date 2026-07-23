/**
 * Schema-v1 command/event contracts for a Bearing run.
 *
 * Models the full staged planning-to-execution lifecycle: create a work
 * request, require consequential owner decisions, record answers, recommend
 * and approve execution modes, and checkpoint journey progress. Provider
 * selection, reasoning, and artifact serving are carried through the
 * envelope rather than embedded inline.
 *
 * Validation is hand-written at this boundary; no JSON Schema dependency is
 * introduced. TypeScript discriminated unions are the source of truth for
 * server logic.
 */
import { createHash } from "node:crypto";
export const COMMAND_SCHEMA_VERSION = 1;
export const EVENT_SCHEMA_VERSION = 1;
const MAX_QA_JSON_BYTES = 640 * 1024;
const MAX_JOURNEY_RESULT_JSON = 640 * 1024;
const SCHEMA_VERSION_MAX = COMMAND_SCHEMA_VERSION;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_STRING = 4096;
const MAX_EVIDENCE_REFS = 64;
export const MAX_RECOMMENDATION_WORK_ITEMS = 64;
export const MAX_RECOMMENDATION_CREWMATES = 16;
export const MAX_RECOMMENDATION_TOKENS = 100_000;
function isObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isNonEmptyString(v, max = MAX_STRING) {
    return typeof v === "string" && v.length > 0 && v.length <= max;
}
function isId(v) {
    return typeof v === "string" && ID_RE.test(v);
}
function isNonNegativeInt(v) {
    return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
}
function isSessionRef(v) {
    if (!isObject(v))
        return false;
    return isId(v.sessionId) && isNonEmptyString(v.actor, 64);
}
function isReadonlyStringArray(v) {
    if (!Array.isArray(v))
        return false;
    if (v.length > MAX_EVIDENCE_REFS)
        return false;
    return v.every((entry) => typeof entry === "string" && entry.length <= MAX_STRING);
}
function isHash(v) {
    return typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
}
/** True if `v` is a syntactically valid v1 envelope of any command type. */
export function parseCommandEnvelope(v) {
    if (!isObject(v))
        return { ok: false, reason: "malformed" };
    if (v.schemaVersion !== COMMAND_SCHEMA_VERSION) {
        if (typeof v.schemaVersion === "number" && v.schemaVersion > SCHEMA_VERSION_MAX) {
            return { ok: false, reason: "future_schema" };
        }
        return { ok: false, reason: "malformed" };
    }
    if (!isId(v.commandId) ||
        !isId(v.runId) ||
        !isNonNegativeInt(v.expectedRevision) ||
        !isSessionRef(v.session) ||
        !isId(v.correlationId)) {
        return { ok: false, reason: "malformed" };
    }
    switch (v.type) {
        case "createWorkRequest":
            if (!isCreateWorkRequestPayload(v.payload))
                return { ok: false, reason: "malformed" };
            break;
        case "requireDecision":
            if (!isRequireDecisionPayload(v.payload))
                return { ok: false, reason: "malformed" };
            break;
        case "recordOwnerAnswer":
            if (!isRecordOwnerAnswerPayload(v.payload))
                return { ok: false, reason: "malformed" };
            break;
        case "recommendExecutionMode":
            if (!isRecommendExecutionModePayload(v.payload))
                return { ok: false, reason: "malformed" };
            break;
        case "approveExecutionMode":
            if (!isApproveExecutionModePayload(v.payload))
                return { ok: false, reason: "malformed" };
            break;
        case "overrideExecutionMode":
            if (!isOverrideExecutionModePayload(v.payload))
                return { ok: false, reason: "malformed" };
            break;
        case "recordJourneyCheckpoint":
            if (!isRecordJourneyCheckpointPayload(v.payload))
                return { ok: false, reason: "malformed" };
            break;
        default:
            return { ok: false, reason: "malformed" };
    }
    return { ok: true, value: v };
}
function isCreateWorkRequestPayload(v) {
    if (!isObject(v))
        return false;
    return isNonEmptyString(v.title) && isNonEmptyString(v.goal);
}
function isRequireDecisionPayload(v) {
    if (!isObject(v))
        return false;
    return (isId(v.decisionId) &&
        isNonEmptyString(v.question) &&
        v.consequential === true);
}
function isRecordOwnerAnswerPayload(v) {
    if (!isObject(v))
        return false;
    return isId(v.decisionId) && isNonEmptyString(v.answer);
}
function isPositiveInt(v) {
    return isNonNegativeInt(v) && v > 0;
}
function isRecommendExecutionModePayload(v) {
    return hasExactKeys(v, ["workItems", "maxCrewmatesPerExplorer", "perAgentTokenEstimate"])
        && isPositiveInt(v.workItems) && v.workItems <= MAX_RECOMMENDATION_WORK_ITEMS
        && isPositiveInt(v.maxCrewmatesPerExplorer) && v.maxCrewmatesPerExplorer <= MAX_RECOMMENDATION_CREWMATES
        && isPositiveInt(v.perAgentTokenEstimate) && v.perAgentTokenEstimate <= MAX_RECOMMENDATION_TOKENS;
}
function isApproveExecutionModePayload(v) {
    return hasExactKeys(v, ["recommendationEventId"]) && isId(v.recommendationEventId);
}
function isOverrideExecutionModePayload(v) {
    return hasExactKeys(v, ["recommendationEventId", "selectedMode"]) && isId(v.recommendationEventId) && (v.selectedMode === "explorer" || v.selectedMode === "expedition");
}
function isRecordJourneyCheckpointPayload(v) {
    if (!isObject(v) || !["stage", "status", "artifacts"].every((key) => key in v) || Object.keys(v).some((key) => !["stage", "status", "artifacts", "planDirectory", "question", "questionDecisionId", "reviewBaselineRevision", "lastResultJson", "qaJson", "gatherQuestionsDiscovered", "selectionProvider", "selectionModel", "selectionReasoning", "providerSessionId"].includes(key)))
        return false;
    const stages = ["set-bearings", "gather-supplies", "map-route", "draft-implementation", "execute-explorer", "execute-expedition", "review"];
    const statuses = ["running", "waiting", "stopped", "failed", "complete"];
    const selectionValues = [v.selectionProvider, v.selectionModel, v.selectionReasoning];
    const selectionValid = selectionValues.every((value) => value === undefined) || selectionValues.every((value) => isNonEmptyString(value, 256));
    return stages.includes(v.stage) && statuses.includes(v.status) && Array.isArray(v.artifacts) && v.artifacts.length <= 256 && v.artifacts.every((path) => isNonEmptyString(path)) &&
        (v.planDirectory === undefined || isNonEmptyString(v.planDirectory)) && (v.question === undefined || isNonEmptyString(v.question)) && (v.questionDecisionId === undefined || (isId(v.questionDecisionId) && v.question !== undefined)) &&
        (v.reviewBaselineRevision === undefined || isNonNegativeInt(v.reviewBaselineRevision)) && (v.lastResultJson === undefined || isNonEmptyString(v.lastResultJson, MAX_JOURNEY_RESULT_JSON)) &&
        (v.qaJson === undefined || isNonEmptyString(v.qaJson, MAX_QA_JSON_BYTES)) && (v.gatherQuestionsDiscovered === undefined || typeof v.gatherQuestionsDiscovered === "boolean") &&
        (v.providerSessionId === undefined || typeof v.providerSessionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.providerSessionId)) && selectionValid;
}
function hasExactKeys(v, keys) {
    return isObject(v) && Object.keys(v).length === keys.length && keys.every((key) => key in v);
}
/** True if `v` is a syntactically valid v1 event envelope. */
export function parseEventEnvelope(v) {
    if (!isObject(v))
        return { ok: false, reason: "malformed" };
    if (v.schemaVersion !== EVENT_SCHEMA_VERSION) {
        if (typeof v.schemaVersion === "number" && v.schemaVersion > EVENT_SCHEMA_VERSION) {
            return { ok: false, reason: "future_schema" };
        }
        return { ok: false, reason: "malformed" };
    }
    if (!isId(v.eventId) ||
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
        !isHash(v.hash)) {
        return { ok: false, reason: "malformed" };
    }
    switch (v.type) {
        case "workRequestCreated":
            if (!isCreateWorkRequestPayload(v.payload))
                return { ok: false, reason: "malformed" };
            break;
        case "decisionRequired":
            if (!isRequireDecisionPayload(v.payload))
                return { ok: false, reason: "malformed" };
            break;
        case "ownerAnswered":
            if (!isRecordOwnerAnswerPayload(v.payload))
                return { ok: false, reason: "malformed" };
            break;
        case "executionModeRecommended":
            if (!isExecutionModeRecommendationPayload(v.payload))
                return { ok: false, reason: "malformed" };
            break;
        case "executionModeApproved":
            if (!isExecutionModeApprovalPayload(v.payload, false))
                return { ok: false, reason: "malformed" };
            break;
        case "executionModeOverridden":
            if (!isExecutionModeApprovalPayload(v.payload, true))
                return { ok: false, reason: "malformed" };
            break;
        case "journeyCheckpointRecorded":
            if (!isRecordJourneyCheckpointPayload(v.payload))
                return { ok: false, reason: "malformed" };
            break;
        default:
            return { ok: false, reason: "malformed" };
    }
    return { ok: true, value: v };
}
function isMode(v) {
    return v === "explorer" || v === "expedition";
}
function isExecutionModeRecommendationPayload(v) {
    if (!isObject(v))
        return false;
    const record = v;
    return Object.keys(record).length === 10 && ["workItems", "maxCrewmatesPerExplorer", "perAgentTokenEstimate", "recommendedMode", "selectedMode", "overridden", "estimatedAgents", "estimatedTokens", "tradeoffs", "launchAuthorized"].every((key) => key in record)
        && isPositiveInt(record.workItems) && isPositiveInt(record.maxCrewmatesPerExplorer) && isPositiveInt(record.perAgentTokenEstimate)
        && isMode(record.recommendedMode) && isMode(record.selectedMode)
        && typeof record.overridden === "boolean" && isPositiveInt(record.estimatedAgents) && isPositiveInt(record.estimatedTokens)
        && record.launchAuthorized === false && isObject(record.tradeoffs)
        && isNonEmptyString(record.tradeoffs.tokens) && isNonEmptyString(record.tradeoffs.coordination)
        && record.overridden === (record.selectedMode !== record.recommendedMode);
}
function isExecutionModeApprovalPayload(v, overridden) {
    return hasExactKeys(v, ["recommendationEventId", "selectedMode", "overridden"]) && isId(v.recommendationEventId) && isMode(v.selectedMode) && v.overridden === overridden;
}
// --- Hashing (deterministic; supports chain integrity, not external claims) -
/** Stable stringification: object keys sorted ascending at every depth. */
export function canonicalStringify(value) {
    return _stringify(value);
}
function _stringify(value) {
    if (Array.isArray(value)) {
        return `[${value.map(_stringify).join(",")}]`;
    }
    if (isObject(value)) {
        const keys = Object.keys(value).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${_stringify(value[k])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}
function sha256(s) {
    return createHash("sha256").update(s).digest("hex");
}
/**
 * Content hash of a command envelope, excluding `commandId` (the dedupe key).
 * Two envelopes with the same commandId and same content hash are idempotent.
 */
export function hashCommand(command) {
    const { commandId: _omit, ...rest } = command;
    return sha256(canonicalStringify(rest));
}
/** Hash of an event envelope over all fields except `hash`. */
export function hashEvent(event) {
    return sha256(canonicalStringify(event));
}
