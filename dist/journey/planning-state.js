import { PLANNING_STATE_VALUES, RECORD_JOURNEY_CHECKPOINT_STAGES, } from "../contracts/run.js";
export const PLANNING_STATES = PLANNING_STATE_VALUES;
export const PLANNING_SIGNALS = [
    "requirementsReady",
    "architectureReady",
    "reconReady",
    "executionPlanReady",
    "planningValidated",
    "ownerApproved",
    "requirementsGap",
    "designConflict",
    "reconFailed",
    "missingValidation",
    "unsafeParallelism",
    "ownerDecisionRequired",
];
export const PLAN_REVIEW_QUESTION = "Approve the complete planning package before implementation?";
export const PLAN_REVIEW_APPROVAL = "Approved for execution-mode selection";
const TRANSITIONS = {
    DRAFT: {
        requirementsReady: "REQUIREMENTS_READY",
        requirementsGap: "REQUIREMENTS_GAP",
    },
    REQUIREMENTS_READY: {
        architectureReady: "ARCHITECTURE_READY",
        designConflict: "DESIGN_CONFLICT",
    },
    ARCHITECTURE_READY: {
        reconReady: "RECON_READY",
        executionPlanReady: "EXECUTION_PLAN_READY",
        reconFailed: "RECON_FAILED",
        missingValidation: "MISSING_VALIDATION",
        unsafeParallelism: "UNSAFE_PARALLELISM",
        ownerDecisionRequired: "OWNER_DECISION_REQUIRED",
    },
    RECON_READY: {
        executionPlanReady: "EXECUTION_PLAN_READY",
        missingValidation: "MISSING_VALIDATION",
        unsafeParallelism: "UNSAFE_PARALLELISM",
        ownerDecisionRequired: "OWNER_DECISION_REQUIRED",
    },
    EXECUTION_PLAN_READY: {
        planningValidated: "PLANNING_VALIDATED",
        missingValidation: "MISSING_VALIDATION",
        unsafeParallelism: "UNSAFE_PARALLELISM",
        ownerDecisionRequired: "OWNER_DECISION_REQUIRED",
    },
    PLANNING_VALIDATED: {
        ownerApproved: "OWNER_APPROVED",
    },
    OWNER_APPROVED: {},
    REQUIREMENTS_GAP: {
        requirementsReady: "REQUIREMENTS_READY",
    },
    DESIGN_CONFLICT: {
        architectureReady: "ARCHITECTURE_READY",
    },
    RECON_FAILED: {
        reconReady: "RECON_READY",
    },
    MISSING_VALIDATION: {
        executionPlanReady: "EXECUTION_PLAN_READY",
        planningValidated: "PLANNING_VALIDATED",
    },
    UNSAFE_PARALLELISM: {
        executionPlanReady: "EXECUTION_PLAN_READY",
        planningValidated: "PLANNING_VALIDATED",
    },
    OWNER_DECISION_REQUIRED: {
        executionPlanReady: "EXECUTION_PLAN_READY",
        planningValidated: "PLANNING_VALIDATED",
    },
};
export function next(state, signal) {
    return TRANSITIONS[state][signal] ?? "illegal_transition";
}
function planningValidation(value) {
    if (!object(value))
        return false;
    return ((value.verdict === "PASS" || value.verdict === "NEEDS_AMENDMENT" || value.verdict === "OWNER_DECISION_REQUIRED")
        && Array.isArray(value.findings)
        && typeof value.checkedContentHash === "string"
        && /^[a-f0-9]{64}$/.test(value.checkedContentHash)
        && typeof value.currentContentHash === "string"
        && /^[a-f0-9]{64}$/.test(value.currentContentHash));
}
export function planningValidationSignal(value) {
    if (!planningValidation(value) || value.checkedContentHash !== value.currentContentHash)
        return undefined;
    return value.verdict === "PASS"
        ? "planningValidated"
        : value.verdict === "NEEDS_AMENDMENT"
            ? "missingValidation"
            : "ownerDecisionRequired";
}
export function advancePlanning(state, signal, validation) {
    if (signal === "planningValidated" && planningValidationSignal(validation) !== signal) {
        return "illegal_transition";
    }
    return next(state, signal);
}
const FAILURE_STATES = new Set([
    "REQUIREMENTS_GAP",
    "DESIGN_CONFLICT",
    "RECON_FAILED",
    "MISSING_VALIDATION",
    "UNSAFE_PARALLELISM",
    "OWNER_DECISION_REQUIRED",
]);
function object(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function planningEvent(value) {
    return object(value) && typeof value.type === "string" && object(value.payload);
}
function workRequestPayload(payload) {
    return typeof payload.title === "string" && typeof payload.goal === "string";
}
function hasOwnEnumerable(payload, key) {
    return (Object.hasOwn(payload, key)
        && Object.prototype.propertyIsEnumerable.call(payload, key));
}
function checkpointPayload(payload) {
    return ((hasOwnEnumerable(payload, "stage")
        && RECORD_JOURNEY_CHECKPOINT_STAGES.includes(payload.stage))
        && (hasOwnEnumerable(payload, "status")
            && (payload.status === "running"
                || payload.status === "waiting"
                || payload.status === "stopped"
                || payload.status === "failed"
                || payload.status === "complete"))
        && Array.isArray(payload.artifacts));
}
function failureState(value) {
    return typeof value === "string" && FAILURE_STATES.has(value)
        ? value
        : undefined;
}
function checkpointPlanningValidation(payload) {
    if (!hasOwnEnumerable(payload, "lastResultJson") || typeof payload.lastResultJson !== "string")
        return undefined;
    try {
        const result = JSON.parse(payload.lastResultJson);
        if (!object(result) || !hasOwnEnumerable(result, "planningValidation"))
            return undefined;
        return planningValidation(result.planningValidation) ? result.planningValidation : undefined;
    }
    catch {
        return undefined;
    }
}
function replayValidatedCheckpoint(state, stage, validation) {
    let candidate = state;
    if (stage === "map-route" || stage === "draft-implementation") {
        if (candidate === "REQUIREMENTS_READY") {
            const architecture = advancePlanning(candidate, "architectureReady");
            if (architecture === "illegal_transition")
                return architecture;
            candidate = architecture;
        }
        if (candidate !== "EXECUTION_PLAN_READY") {
            const executionPlan = advancePlanning(candidate, "executionPlanReady");
            if (executionPlan === "illegal_transition")
                return executionPlan;
            candidate = executionPlan;
        }
    }
    return advancePlanning(candidate, "planningValidated", validation);
}
/**
 * Project planning state from the recorded event stream.
 *
 * The ledger remains authoritative; this projection neither persists state nor
 * performs I/O. Unknown and malformed entries are ignored.
 */
export function derivePlanningState(events) {
    let state = "DRAFT";
    const reviewDecisions = new Set();
    for (const candidate of events) {
        if (!planningEvent(candidate))
            continue;
        switch (candidate.type) {
            case "workRequestCreated":
                if (workRequestPayload(candidate.payload))
                    state = "DRAFT";
                break;
            case "executionModeApproved":
            case "executionModeOverridden":
                break;
            case "journeyCheckpointRecorded": {
                const payload = candidate.payload;
                if (!checkpointPayload(payload))
                    break;
                const recordedFailure = hasOwnEnumerable(payload, "planningFailure")
                    ? failureState(payload.planningFailure)
                    : undefined;
                if (recordedFailure) {
                    state = recordedFailure;
                    break;
                }
                if (payload.status === "failed") {
                    break;
                }
                const validation = checkpointPlanningValidation(payload);
                if (hasOwnEnumerable(payload, "planningState") && typeof payload.planningState === "string" && payload.planningState !== "OWNER_APPROVED" && PLANNING_STATES.includes(payload.planningState)) {
                    if (payload.planningState === "PLANNING_VALIDATED") {
                        const validated = replayValidatedCheckpoint(state, payload.stage, validation);
                        if (validated !== "illegal_transition")
                            state = validated;
                    }
                    else {
                        state = payload.planningState;
                        const signal = planningValidationSignal(validation);
                        if (signal) {
                            const validated = advancePlanning(state, signal, validation);
                            if (validated !== "illegal_transition")
                                state = validated;
                        }
                    }
                    break;
                }
                if (payload.status !== "complete")
                    break;
                if (payload.stage === "gather-supplies") {
                    state = "REQUIREMENTS_READY";
                }
                else if (payload.stage === "map-route") {
                    state = "ARCHITECTURE_READY";
                }
                else if (payload.stage === "draft-implementation") {
                    const executionPlan = advancePlanning(state, "executionPlanReady");
                    if (executionPlan !== "illegal_transition") {
                        state = executionPlan;
                        const signal = planningValidationSignal(validation);
                        if (signal) {
                            const validated = advancePlanning(executionPlan, signal, validation);
                            if (validated !== "illegal_transition")
                                state = validated;
                        }
                    }
                }
                break;
            }
            case "decisionRequired":
                if (candidate.payload.question === PLAN_REVIEW_QUESTION && typeof candidate.payload.decisionId === "string") {
                    reviewDecisions.add(candidate.payload.decisionId);
                }
                break;
            case "ownerAnswered":
                if (candidate.actor === "owner"
                    && typeof candidate.payload.decisionId === "string"
                    && reviewDecisions.has(candidate.payload.decisionId)
                    && candidate.payload.answer === PLAN_REVIEW_APPROVAL) {
                    const approved = next(state, "ownerApproved");
                    if (approved !== "illegal_transition")
                        state = approved;
                }
                break;
            case "executionModeRecommended":
                break;
        }
    }
    return state;
}
