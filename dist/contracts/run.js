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
import { parseRuntimeState } from "./runtime-state.js";
import { HARD_TRIGGER_IDS, MAX_COMPLEXITY_SCORE, isSelectionSignals, } from "../execution/selection-score.js";
import { EXECUTION_MODES, EXECUTION_ORCHESTRATIONS } from "../execution/execution-mode.js";
export const COMMAND_SCHEMA_VERSION = 1;
export const EVENT_SCHEMA_VERSION = 1;
const MAX_QA_JSON_BYTES = 640 * 1024;
const MAX_JOURNEY_RESULT_JSON = 640 * 1024;
/**
 * Canonical planning-state list. It lives here, not in the journey layer,
 * because `planning-state.ts` already imports from this module — defining it
 * there and importing back would be a cycle. `PlanningState` is re-exported
 * from `planning-state.ts`, so journey consumers are unchanged.
 */
export const PLANNING_STATE_VALUES = [
    "DRAFT",
    "REQUIREMENTS_READY",
    "ARCHITECTURE_READY",
    "RECON_READY",
    "EXECUTION_PLAN_READY",
    "PLANNING_VALIDATED",
    "OWNER_APPROVED",
    "REQUIREMENTS_GAP",
    "DESIGN_CONFLICT",
    "RECON_FAILED",
    "MISSING_VALIDATION",
    "UNSAFE_PARALLELISM",
    "OWNER_DECISION_REQUIRED",
];
const PLANNING_FAILURE_VALUES = [
    "REQUIREMENTS_GAP",
    "DESIGN_CONFLICT",
    "RECON_FAILED",
    "MISSING_VALIDATION",
    "UNSAFE_PARALLELISM",
    "OWNER_DECISION_REQUIRED",
];
export const JOURNEY_TOKEN_BUDGET_STATES = ["within_budget", "exhausted"];
export const JOURNEY_RECOVERY_OUTCOMES = ["repaired", "stopped"];
export const MAX_JOURNEY_TOKEN_TOTAL = Number.MAX_SAFE_INTEGER;
export const MAX_JOURNEY_RECOVERY_ATTEMPTS = 16;
export const RECORD_JOURNEY_CHECKPOINT_STAGES = [
    "repository-fit",
    "set-bearings",
    "gather-supplies",
    "map-route",
    "recon",
    "draft-implementation",
    "execute-explorer",
    "execute-expedition",
    "review",
];
const SCHEMA_VERSION_MAX = COMMAND_SCHEMA_VERSION;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_STRING = 4096;
const MAX_EVIDENCE_REFS = 64;
export const MAX_RECOMMENDATION_WORK_ITEMS = 64;
export const MAX_RECOMMENDATION_CREWMATES = 16;
export const MAX_RECOMMENDATION_TOKENS = 100_000;
// Bounds for the optional version-2 signal vector. `expectedConcurrency` and
// `phaseExplorerCount` reuse the work-item bound (both count concurrent agents),
// and `sharedFileOverlapCount` reuses the edge bound (both are pairwise-derived
// counts over the same slice set).
export const MAX_RECOMMENDATION_PHASES = 32;
export const MAX_RECOMMENDATION_SLICES = 128;
export const MAX_RECOMMENDATION_EDGES = 512;
export const MAX_RECOMMENDATION_SERVICES = 32;
export const MAX_RECOMMENDATION_CHECKPOINTS = 64;
/** A threshold above the highest achievable score could never be met. */
export const MAX_RECOMMENDATION_THRESHOLD = MAX_COMPLEXITY_SCORE;
export const MAX_RECOMMENDATION_SUB_EXPLORERS = 16;
/**
 * Canonical shape and guard for the additive `verification` checkpoint key. Exported so the read
 * paths that re-validate ledger data on load share this one rule instead of restating it — a second
 * copy that drifts from this one is the "two halves that must agree" defect this program retires.
 */
const VERIFICATION_VERDICTS = {
    validator: ["PASS", "NEEDS_MORE_EVIDENCE", "FAIL"],
    grader: ["strong", "acceptable", "weak"],
    "park-ranger": ["block", "repair-required", "accept-with-findings", "accept"],
};
const VERIFICATION_CHECKPOINT_KEYS = [
    "layer",
    "verdict",
    "rubricVersion",
    "findingCount",
    "completedSlices",
    "reviewedSliceIds",
    "confirmedFindings",
];
/**
 * A rubric version is a short identifier (today `"1"`). `layer` and `verdict` are already bounded by
 * their closed vocabularies; this is the only free-form string left, and the ledger is append-only,
 * so an oversized value can never be removed and permanently inflates the bounded projection.
 */
const MAX_RUBRIC_VERSION = 64;
const MAX_VERIFICATION_ITEMS = 128;
const EXECUTION_SLICE_ID = /^(?:[A-Za-z]+\d+|\d+(?:\.\d+)+)$/;
const FINDING_REF = /^[a-f0-9]{64}$/;
function isVerificationLayer(value) {
    return isNonEmptyString(value) && Object.hasOwn(VERIFICATION_VERDICTS, value);
}
export function isVerificationVerdict(layer, verdict) {
    return isNonEmptyString(verdict)
        && VERIFICATION_VERDICTS[layer].some((allowed) => allowed === verdict);
}
export function isVerificationCheckpointPayload(v) {
    if (!isObject(v) || !Object.hasOwn(v, "layer") || !Object.hasOwn(v, "verdict"))
        return false;
    if (Object.keys(v).some((key) => !VERIFICATION_CHECKPOINT_KEYS.some((allowed) => allowed === key)))
        return false;
    // Optional fields must be OWN properties, not inherited. Object.keys() omits inherited keys, so
    // the allowlist above passes for a prototype-carried value while the destructure below would
    // still read it — the live event would then project metadata that disappears on JSON round-trip
    // and replay. Same in-vs-hasOwn class as the required-key guard.
    if ((v.rubricVersion !== undefined && !Object.hasOwn(v, "rubricVersion"))
        || (v.findingCount !== undefined && !Object.hasOwn(v, "findingCount"))
        || (v.completedSlices !== undefined && !Object.hasOwn(v, "completedSlices"))
        || (v.reviewedSliceIds !== undefined && !Object.hasOwn(v, "reviewedSliceIds"))
        || (v.confirmedFindings !== undefined && !Object.hasOwn(v, "confirmedFindings")))
        return false;
    const { layer, verdict, rubricVersion, findingCount, completedSlices, reviewedSliceIds, confirmedFindings } = v;
    if (!isVerificationLayer(layer)
        || !isVerificationVerdict(layer, verdict)
        || (rubricVersion !== undefined && !isNonEmptyString(rubricVersion, MAX_RUBRIC_VERSION))
        || (findingCount !== undefined && !(typeof findingCount === "number" && Number.isSafeInteger(findingCount) && findingCount >= 0)))
        return false;
    if (completedSlices !== undefined
        && (!isCanonicalCompletedSlices(completedSlices) || layer !== "validator" || verdict !== "PASS"))
        return false;
    if (reviewedSliceIds !== undefined
        && (!isCanonicalStringArray(reviewedSliceIds, isExecutionSliceId) || layer !== "park-ranger"))
        return false;
    if (confirmedFindings !== undefined
        && (!isCanonicalConfirmedFindings(confirmedFindings)
            || layer !== "park-ranger"
            || typeof findingCount !== "number"
            || findingCount !== confirmedFindings.length))
        return false;
    return true;
}
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
export function isJourneyTokenUsage(value) {
    if (!isObject(value)
        || !Object.hasOwn(value, "total")
        || !Object.hasOwn(value, "budget")
        || !Object.hasOwn(value, "state")
        || Object.keys(value).some((key) => key !== "total" && key !== "budget" && key !== "state"))
        return false;
    const { total, budget, state } = value;
    if (!isNonNegativeInt(total)
        || total > MAX_JOURNEY_TOKEN_TOTAL
        || !isNonNegativeInt(budget)
        || budget === 0
        || !JOURNEY_TOKEN_BUDGET_STATES.some((allowed) => allowed === state))
        return false;
    return true;
}
export function isJourneyRecoveryOutcome(value) {
    return isObject(value)
        && Object.hasOwn(value, "outcome")
        && Object.hasOwn(value, "attempts")
        && Object.keys(value).every((key) => key === "outcome" || key === "attempts")
        && JOURNEY_RECOVERY_OUTCOMES.some((allowed) => allowed === value.outcome)
        && isNonNegativeInt(value.attempts)
        && value.attempts > 0
        && value.attempts <= MAX_JOURNEY_RECOVERY_ATTEMPTS;
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
function isNativeDenseArray(v) {
    if (!Array.isArray(v)
        || Object.getPrototypeOf(v) !== Array.prototype
        || v.length > MAX_VERIFICATION_ITEMS
        || Object.keys(v).length !== v.length)
        return false;
    for (let index = 0; index < v.length; index += 1) {
        if (!Object.hasOwn(v, index))
            return false;
    }
    return true;
}
function isExecutionSliceId(v) {
    return isNonEmptyString(v, 128) && EXECUTION_SLICE_ID.test(v);
}
function isPriority(v) {
    return v === "P0" || v === "P1" || v === "P2" || v === "P3";
}
function isCanonicalStringArray(v, predicate) {
    if (!isNativeDenseArray(v) || v.length === 0 || !v.every(predicate))
        return false;
    for (let index = 1; index < v.length; index += 1) {
        if (v[index - 1] >= v[index])
            return false;
    }
    return true;
}
function isCanonicalCompletedSlice(v) {
    if (!isObject(v)
        || Object.keys(v).length !== 2
        || !Object.hasOwn(v, "sliceId")
        || !Object.hasOwn(v, "requirementIds"))
        return false;
    return isExecutionSliceId(v.sliceId) && isCanonicalStringArray(v.requirementIds, (value) => {
        return typeof value === "string"
            && value.length <= MAX_REQUIREMENT_REF
            && REQUIREMENT_REF.test(value);
    });
}
function isCanonicalCompletedSlices(v) {
    if (!isNativeDenseArray(v) || !v.every(isCanonicalCompletedSlice))
        return false;
    for (let index = 1; index < v.length; index += 1) {
        if (v[index - 1].sliceId >= v[index].sliceId)
            return false;
    }
    return true;
}
function isCanonicalConfirmedFinding(v) {
    if (!isObject(v)
        || Object.keys(v).length !== 3
        || !Object.hasOwn(v, "findingRef")
        || !Object.hasOwn(v, "priority")
        || !Object.hasOwn(v, "sliceIds"))
        return false;
    return typeof v.findingRef === "string"
        && FINDING_REF.test(v.findingRef)
        && isPriority(v.priority)
        && isCanonicalStringArray(v.sliceIds, isExecutionSliceId);
}
function isCanonicalConfirmedFindings(v) {
    if (!isNativeDenseArray(v) || !v.every(isCanonicalConfirmedFinding))
        return false;
    for (let index = 1; index < v.length; index += 1) {
        if (v[index - 1].findingRef >= v[index].findingRef)
            return false;
    }
    return true;
}
const MAX_REQUIREMENT_REFS = 128;
const MAX_REQUIREMENT_REF = 128;
const REQUIREMENT_REF = /^(?:AC|RISK)-[A-Z0-9][A-Z0-9.-]*$/;
export function isRequirementRefs(v) {
    if (!Array.isArray(v) || v.length === 0 || v.length > MAX_REQUIREMENT_REFS)
        return false;
    for (let index = 0; index < v.length; index += 1) {
        const entry = v[index];
        if (!Object.hasOwn(v, index)
            || typeof entry !== "string"
            || entry.length > MAX_REQUIREMENT_REF
            || !REQUIREMENT_REF.test(entry))
            return false;
    }
    return true;
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
        case "recordOwnerImprovementApplication":
            if (!isRecordOwnerImprovementApplicationPayload(v.payload))
                return { ok: false, reason: "malformed" };
            break;
        case "approveLegacyRoleRoutes":
            if (!isApproveLegacyRoleRoutesPayload(v.payload))
                return { ok: false, reason: "malformed" };
            break;
        case "approveLegacyExecutionContract":
            if (!isApproveLegacyExecutionContractPayload(v.payload))
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
    const keys = Object.keys(v);
    return keys.every((key) => key === "decisionId" || key === "answer" || key === "ownerApprovedContentHash")
        && isId(v.decisionId)
        && isNonEmptyString(v.answer)
        && (v.ownerApprovedContentHash === undefined || isHash(v.ownerApprovedContentHash));
}
/**
 * Envelope shape only: exactly two payload keys, a canonical hash, and a dense array of
 * exactly-three-key route bindings. Which roles are required, which route ids are
 * registered, and whether the hash matches are the workflow aggregate's rules — restating
 * them here would create a second copy that can drift from the one that fails closed.
 */
function isApproveLegacyRoleRoutesPayload(v) {
    if (!isObject(v))
        return false;
    const keys = Object.keys(v);
    if (keys.length !== 2 || !keys.every((key) => key === "roleRoutes" || key === "approvedContentHash"))
        return false;
    if (!isHash(v.approvedContentHash))
        return false;
    if (!Array.isArray(v.roleRoutes) || v.roleRoutes.length === 0 || v.roleRoutes.length > MAX_EVIDENCE_REFS)
        return false;
    return v.roleRoutes.every((route, index) => {
        if (!Object.hasOwn(v.roleRoutes, index) || !isObject(route))
            return false;
        const routeKeys = Object.keys(route);
        return routeKeys.length === 3
            && isNonEmptyString(route.role)
            && isNonEmptyString(route.primary)
            && Array.isArray(route.fallbacks)
            && route.fallbacks.every((item, at) => Object.hasOwn(route.fallbacks, at) && isNonEmptyString(item));
    });
}
function isApproveLegacyExecutionContractPayload(v) {
    if (!isObject(v))
        return false;
    const keys = Object.keys(v);
    if (keys.length !== 2 || !keys.every((key) => key === "contract" || key === "approvedContentHash"))
        return false;
    if (!isHash(v.approvedContentHash))
        return false;
    return isObject(v.contract);
}
function isPositiveInt(v) {
    return isNonNegativeInt(v) && v > 0;
}
function hasRequiredAndOptionalKeys(v, required, optional) {
    if (!isObject(v))
        return false;
    return required.every((key) => Object.hasOwn(v, key))
        && Object.keys(v).every((key) => required.includes(key) || optional.includes(key));
}
/**
 * Structure comes from the selection module, so the producer and this parser
 * cannot disagree about the shape; the bounds are this boundary's own.
 */
function isSelectionSignalsPayload(v) {
    if (!isSelectionSignals(v))
        return false;
    const complexity = v.complexity;
    return v.threshold <= MAX_RECOMMENDATION_THRESHOLD
        && v.subExplorerCount <= MAX_RECOMMENDATION_SUB_EXPLORERS
        && v.hardTriggers.phaseExplorerCount <= MAX_RECOMMENDATION_WORK_ITEMS
        && complexity.phaseCount <= MAX_RECOMMENDATION_PHASES
        && complexity.sliceCount <= MAX_RECOMMENDATION_SLICES
        && complexity.dependencyEdgeCount <= MAX_RECOMMENDATION_EDGES
        && complexity.sharedFileOverlapCount <= MAX_RECOMMENDATION_EDGES
        && complexity.serviceCount <= MAX_RECOMMENDATION_SERVICES
        && complexity.expectedConcurrency <= MAX_RECOMMENDATION_WORK_ITEMS
        && complexity.integrationCheckpointCount <= MAX_RECOMMENDATION_CHECKPOINTS;
}
function isRecommendExecutionModePayload(v) {
    return hasRequiredAndOptionalKeys(v, ["workItems", "maxCrewmatesPerExplorer", "perAgentTokenEstimate"], ["selection"])
        && isPositiveInt(v.workItems) && v.workItems <= MAX_RECOMMENDATION_WORK_ITEMS
        && isPositiveInt(v.maxCrewmatesPerExplorer) && v.maxCrewmatesPerExplorer <= MAX_RECOMMENDATION_CREWMATES
        && isPositiveInt(v.perAgentTokenEstimate) && v.perAgentTokenEstimate <= MAX_RECOMMENDATION_TOKENS
        && (!Object.hasOwn(v, "selection") || isSelectionSignalsPayload(v.selection));
}
function isApproveExecutionModePayload(v) {
    return hasExactKeys(v, ["recommendationEventId"]) && isId(v.recommendationEventId);
}
function isOverrideExecutionModePayload(v) {
    return hasExactKeys(v, ["recommendationEventId", "selectedMode"]) && isId(v.recommendationEventId) && isMode(v.selectedMode);
}
function isRecordJourneyCheckpointPayload(v) {
    if (!isObject(v))
        return false;
    const requiredKeys = ["stage", "status", "artifacts"];
    const optionalKeys = ["planDirectory", "question", "questionDecisionId", "reviewBaselineRevision", "lastResultJson", "qaJson", "gatherQuestionsDiscovered", "selectionProvider", "selectionModel", "selectionReasoning", "providerSessionId", "runtimeStateJson", "tokenUsage", "recoveryOutcome", "verification", "planningState", "planningFailure", "ownerApprovedContentHash", "repositoryFitDecision", "resolvedPlanDirectory", "improvementProposalRef", "requirementRefs", "review"];
    if (!requiredKeys.every((key) => Object.hasOwn(v, key))
        || Object.keys(v).some((key) => ![...requiredKeys, ...optionalKeys].includes(key))
        || optionalKeys.some((key) => !Object.hasOwn(v, key) && v[key] !== undefined))
        return false;
    const ownValue = (key) => Object.hasOwn(v, key) ? v[key] : undefined;
    const statuses = ["running", "waiting", "stopped", "failed", "complete"];
    const planDirectory = ownValue("planDirectory");
    const question = ownValue("question");
    const questionDecisionId = ownValue("questionDecisionId");
    const reviewBaselineRevision = ownValue("reviewBaselineRevision");
    const lastResultJson = ownValue("lastResultJson");
    const qaJson = ownValue("qaJson");
    const gatherQuestionsDiscovered = ownValue("gatherQuestionsDiscovered");
    const providerSessionId = ownValue("providerSessionId");
    const runtimeStateJson = ownValue("runtimeStateJson");
    const tokenUsage = ownValue("tokenUsage");
    const recoveryOutcome = ownValue("recoveryOutcome");
    const verification = ownValue("verification");
    const planningState = ownValue("planningState");
    const planningFailure = ownValue("planningFailure");
    const repositoryFitDecision = ownValue("repositoryFitDecision");
    const resolvedPlanDirectory = ownValue("resolvedPlanDirectory");
    const improvementProposalRef = ownValue("improvementProposalRef");
    const requirementRefs = ownValue("requirementRefs");
    const review = ownValue("review");
    const selectionValues = [ownValue("selectionProvider"), ownValue("selectionModel"), ownValue("selectionReasoning")];
    const selectionValid = selectionValues.every((value) => value === undefined) || selectionValues.every((value) => isNonEmptyString(value, 256));
    return RECORD_JOURNEY_CHECKPOINT_STAGES.includes(v.stage) && statuses.includes(v.status) && Array.isArray(v.artifacts) && v.artifacts.length <= 256 && v.artifacts.every((path) => isNonEmptyString(path)) &&
        (planDirectory === undefined || isNonEmptyString(planDirectory)) && (question === undefined || isNonEmptyString(question)) && (questionDecisionId === undefined || (isId(questionDecisionId) && question !== undefined)) &&
        (reviewBaselineRevision === undefined || isNonNegativeInt(reviewBaselineRevision)) && (lastResultJson === undefined || isNonEmptyString(lastResultJson, MAX_JOURNEY_RESULT_JSON)) &&
        (qaJson === undefined || isNonEmptyString(qaJson, MAX_QA_JSON_BYTES)) && (gatherQuestionsDiscovered === undefined || typeof gatherQuestionsDiscovered === "boolean") &&
        (providerSessionId === undefined || typeof providerSessionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(providerSessionId)) &&
        (runtimeStateJson === undefined || typeof runtimeStateJson === "string" && parseRuntimeState(runtimeStateJson).ok) &&
        (tokenUsage === undefined || isJourneyTokenUsage(tokenUsage)) &&
        (recoveryOutcome === undefined || isJourneyRecoveryOutcome(recoveryOutcome)) &&
        (verification === undefined || isVerificationCheckpointPayload(verification)) &&
        (planningState === undefined || typeof planningState === "string" && PLANNING_STATE_VALUES.some((state) => state === planningState)) &&
        (planningFailure === undefined || typeof planningFailure === "string" && PLANNING_FAILURE_VALUES.some((state) => state === planningFailure)) &&
        (repositoryFitDecision === undefined || isRepositoryFitDecision(repositoryFitDecision)) &&
        (resolvedPlanDirectory === undefined || isNonEmptyString(resolvedPlanDirectory)) &&
        (improvementProposalRef === undefined || isHash(improvementProposalRef)) &&
        (requirementRefs === undefined || isRequirementRefs(requirementRefs)) &&
        (review === undefined || isReviewRecords(review)) && selectionValid;
}
// --- Independent review gate (additive checkpoint key) ----------------------
//
// A generic MCP client certifies one exact repository revision without the
// Bearing CLI. The record rides the existing checkpoint payload rather than a
// new event type: compaction truncates the ledger and keeps only the snapshot,
// and the snapshot carries `journeyCheckpoint` — so an event-only record would
// not survive the very sealing it is meant to certify.
export const REVIEW_CLASSES = ["general", "security"];
export const REVIEW_VERDICTS = ["PASS", "FAIL", "NEEDS_MORE_EVIDENCE"];
/** A short, path-blind digest. Raw session identifiers never enter the record. */
const REVIEW_IDENTITY = /^[a-f0-9]{16}$/;
/** Git object names, SHA-1 through SHA-256. */
const REVIEW_REVISION = /^[0-9a-f]{40,64}$/;
const REVIEW_COMMAND_ID = /^(?:CMD|PROC)-[A-Z0-9][A-Z0-9.-]*$/;
const MAX_REVIEW_TEXT = 512;
const MAX_REVIEW_ITEMS = 64;
function isReviewIdentity(v) {
    return typeof v === "string" && REVIEW_IDENTITY.test(v);
}
function isReviewCommandEvidence(v) {
    return hasExactKeys(v, ["commandId", "status", "summary"])
        && typeof v.commandId === "string" && REVIEW_COMMAND_ID.test(v.commandId)
        && (v.status === "passed" || v.status === "failed")
        && isNonEmptyString(v.summary, MAX_REVIEW_TEXT);
}
function isReviewFinding(v) {
    return hasExactKeys(v, ["summary", "evidence"])
        && isNonEmptyString(v.summary, MAX_REVIEW_TEXT)
        && isNonEmptyString(v.evidence, MAX_REVIEW_TEXT);
}
function isReviewCommands(v) {
    if (!isNativeDenseArray(v) || v.length === 0 || v.length > MAX_REVIEW_ITEMS || !v.every(isReviewCommandEvidence))
        return false;
    for (let index = 1; index < v.length; index += 1) {
        if (v[index - 1].commandId >= v[index].commandId)
            return false;
    }
    return true;
}
/**
 * One review record. The independence and verdict-support rules live here, not
 * only in the write path: a ledger entry that certifies its own implementer, or
 * claims PASS over a failed rerun, is malformed wherever it is read from.
 */
export function isReviewRecord(v) {
    if (!hasExactKeys(v, [
        "reviewClass", "verdict", "contractHash", "reviewedRevision", "scope",
        "reviewerIdentity", "implementerIdentities", "commands", "findings",
    ]))
        return false;
    if (!REVIEW_CLASSES.some((allowed) => allowed === v.reviewClass)
        || !REVIEW_VERDICTS.some((allowed) => allowed === v.verdict)
        || !isHash(v.contractHash)
        || typeof v.reviewedRevision !== "string" || !REVIEW_REVISION.test(v.reviewedRevision)
        || !isCanonicalStringArray(v.scope, isExecutionSliceId)
        || !isReviewIdentity(v.reviewerIdentity)
        || !isCanonicalStringArray(v.implementerIdentities, isReviewIdentity)
        || !isReviewCommands(v.commands)
        || !isNativeDenseArray(v.findings) || v.findings.length > MAX_REVIEW_ITEMS || !v.findings.every(isReviewFinding))
        return false;
    if (v.implementerIdentities.includes(v.reviewerIdentity))
        return false;
    if (v.verdict === "PASS" && v.commands.some((command) => command.status === "failed"))
        return false;
    return v.verdict === "PASS" || v.findings.length > 0;
}
/**
 * At most one record per class, all bound to the same reviewed revision. A
 * remediation commit moves that revision, so no surviving pass can certify it.
 */
export function isReviewRecords(v) {
    if (!isNativeDenseArray(v) || v.length === 0 || v.length > REVIEW_CLASSES.length || !v.every(isReviewRecord))
        return false;
    for (let index = 1; index < v.length; index += 1) {
        if (v[index - 1].reviewClass >= v[index].reviewClass)
            return false;
    }
    return v.every((record) => record.reviewedRevision === v[0].reviewedRevision);
}
function isRecordOwnerImprovementApplicationPayload(v) {
    return hasExactKeys(v, ["improvementProposalRef", "externalEvidenceHash", "surface", "targetJson", "valueJson"])
        && typeof v.improvementProposalRef === "string"
        && /^[a-f0-9]{64}$/.test(v.improvementProposalRef)
        && typeof v.externalEvidenceHash === "string"
        && /^[a-f0-9]{64}$/.test(v.externalEvidenceHash)
        && isNonEmptyString(v.surface, 128)
        && isCanonicalJson(v.targetJson)
        && isCanonicalJson(v.valueJson);
}
function isCanonicalJson(v) {
    if (typeof v !== "string" || v.length === 0 || v.length > MAX_STRING)
        return false;
    try {
        return canonicalStringify(JSON.parse(v)) === v;
    }
    catch {
        return false;
    }
}
function hasExactKeys(v, keys) {
    return isObject(v)
        && Object.keys(v).length === keys.length
        && keys.every((key) => Object.hasOwn(v, key));
}
function isRepositoryFitDecision(v) {
    if (hasExactKeys(v, ["outcome"]) && v.outcome === "declined")
        return true;
    return hasExactKeys(v, ["outcome", "planDirectory", "repository", "decidedAt"])
        && (v.outcome === "confirmed" || v.outcome === "redirected")
        && isNonEmptyString(v.planDirectory)
        && isNonEmptyString(v.repository)
        && isNonEmptyString(v.decidedAt);
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
        case "ownerImprovementApplicationRecorded":
            if (!isRecordOwnerImprovementApplicationPayload(v.payload))
                return { ok: false, reason: "malformed" };
            break;
        case "legacyRoleRoutesApproved":
            if (!isApproveLegacyRoleRoutesPayload(v.payload))
                return { ok: false, reason: "malformed" };
            break;
        case "legacyExecutionContractApproved":
            if (!isApproveLegacyExecutionContractPayload(v.payload))
                return { ok: false, reason: "malformed" };
            break;
        default:
            return { ok: false, reason: "malformed" };
    }
    return { ok: true, value: v };
}
function isMode(v) {
    return EXECUTION_MODES.includes(v);
}
/** Emitted in declaration order, never sorted, so replay array equality is stable. */
function isFiredHardTriggerList(v) {
    if (!Array.isArray(v) || v.length > HARD_TRIGGER_IDS.length)
        return false;
    let next = 0;
    for (const entry of v) {
        const index = HARD_TRIGGER_IDS.findIndex((id, at) => at >= next && id === entry);
        if (index < 0)
            return false;
        next = index + 1;
    }
    return true;
}
const V2_RECOMMENDATION_KEYS = ["selection", "algorithmVersion", "complexityScore", "firedHardTriggers", "recommendedOrchestration"];
function isExecutionModeRecommendationPayload(v) {
    if (!isObject(v))
        return false;
    const record = v;
    const present = V2_RECOMMENDATION_KEYS.filter((key) => Object.hasOwn(record, key));
    // Half a version-2 group is a corrupt event, not a lenient upgrade.
    if (present.length !== 0 && present.length !== V2_RECOMMENDATION_KEYS.length)
        return false;
    if (present.length === V2_RECOMMENDATION_KEYS.length && !(record.algorithmVersion === 2
        && isSelectionSignalsPayload(record.selection)
        && isNonNegativeInt(record.complexityScore) && record.complexityScore <= MAX_COMPLEXITY_SCORE
        && isFiredHardTriggerList(record.firedHardTriggers)
        && EXECUTION_ORCHESTRATIONS.includes(record.recommendedOrchestration)
        // Trail Boss is a role inside expedition mode; it is never paired with explorer mode.
        && (record.recommendedOrchestration !== "trail-boss" || record.recommendedMode === "expedition")))
        return false;
    return hasRequiredAndOptionalKeys(record, ["workItems", "maxCrewmatesPerExplorer", "perAgentTokenEstimate", "recommendedMode", "selectedMode", "overridden", "estimatedAgents", "estimatedTokens", "tradeoffs", "launchAuthorized"], V2_RECOMMENDATION_KEYS)
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
