/**
 * Pure WorkflowAggregate reducer for a Bearing run.
 *
 * No time, random, filesystem, network, or mutable globals: identifiers,
 * timestamps, and hashes are injected (`DecideDeps`) or computed from inputs.
 * The reducer owns legal transitions only; persistence, delivery, and adapter
 * behavior live elsewhere.
 */
import { hashCommand, hashEvent, } from "../contracts/run.js";
import { recommendExecutionMode, recommendExecutionModeV2 } from "../execution/execution-mode.js";
import { isSelectionSignals } from "../execution/selection-score.js";
const issuedStates = new WeakSet();
const durableEvidence = new WeakSet();
const DURABLE_EVIDENCE = Symbol("durable-owner-evidence");
function issueRunState(state) {
    issuedStates.add(state);
    return state;
}
export function isIssuedRunState(value) {
    return typeof value === "object" && value !== null && issuedStates.has(value);
}
function mintDurableOwnerEvidence(kind, recordId, recommendationEventId, selectedMode) {
    const evidence = Object.freeze({ kind, recordedBy: "owner", durable: true, recordId, recommendationEventId, selectedMode, [DURABLE_EVIDENCE]: true });
    durableEvidence.add(evidence);
    return evidence;
}
export function isDurableOwnerEvidence(value) {
    return typeof value === "object" && value !== null && durableEvidence.has(value) && Object.isFrozen(value);
}
export function durableOwnerEvidence(state) {
    return isIssuedRunState(state) && state.executionApproval && state.executionRecommendation
        ? mintDurableOwnerEvidence(state.executionApproval.kind, state.executionApproval.eventId, state.executionRecommendation.eventId, state.executionApproval.selectedMode)
        : undefined;
}
const OWNER_ACTOR = "owner";
export class ReplayError extends Error {
    constructor(message) {
        super(message);
        this.name = "ReplayError";
    }
}
export function initialRunState(runId) {
    return issueRunState({
        runId,
        revision: 0,
        events: [],
        outcomes: new Map(),
        pendingDecision: null,
        workRequestCreated: false,
        executionRecommendation: null,
        executionApproval: null,
        journeyCheckpoint: null,
    });
}
/**
 * Apply one event to state. Used by both `decide` and `replay` so the
 * projection is the single source of truth for state derivation.
 */
function applyEvent(state, event) {
    const outcomes = new Map(state.outcomes);
    const prev = outcomes.get(event.causationId);
    const eventIds = prev ? [...prev.eventIds, event.eventId] : [event.eventId];
    outcomes.set(event.causationId, {
        commandId: event.causationId,
        contentHash: event.commandContentHash,
        eventIds,
    });
    let pendingDecision = state.pendingDecision;
    let workRequestCreated = state.workRequestCreated;
    let executionRecommendation = state.executionRecommendation;
    let executionApproval = state.executionApproval;
    let journeyCheckpoint = state.journeyCheckpoint;
    switch (event.type) {
        case "workRequestCreated":
            workRequestCreated = true;
            break;
        case "decisionRequired":
            pendingDecision = {
                decisionId: event.payload.decisionId,
                question: event.payload.question,
            };
            break;
        case "ownerAnswered":
            pendingDecision = null;
            break;
        case "executionModeRecommended":
            executionRecommendation = { ...event.payload, eventId: event.eventId };
            break;
        case "executionModeApproved":
        case "executionModeOverridden":
            executionApproval = { eventId: event.eventId, kind: event.type === "executionModeApproved" ? "owner-approval" : "owner-override", selectedMode: event.payload.selectedMode };
            break;
        case "journeyCheckpointRecorded":
            journeyCheckpoint = { ...event.payload, eventId: event.eventId };
            if (typeof event.payload.question === "string" && typeof event.payload.questionDecisionId === "string") {
                pendingDecision = { decisionId: event.payload.questionDecisionId, question: event.payload.question };
            }
            break;
        case "ownerImprovementApplicationRecorded":
            // Typed evidence is carried by the event; no additional RunState projection required.
            break;
    }
    return issueRunState({
        runId: state.runId,
        revision: state.events.length + 1,
        events: [...state.events, event],
        outcomes,
        pendingDecision,
        workRequestCreated,
        executionRecommendation,
        executionApproval,
        journeyCheckpoint,
    });
}
/** Fold a recorded event stream back into state. */
export function replay(events) {
    const runId = events.length > 0 ? events[0].runId : "";
    let state = initialRunState(runId);
    for (const event of events) {
        validateReplayEvent(state, event);
        state = applyEvent(state, event);
    }
    return state;
}
/** The eight fields every algorithm version has compared since schema v1. */
function sameRecommendation(derived, payload) {
    return derived.recommendedMode === payload.recommendedMode && derived.selectedMode === payload.selectedMode
        && derived.overridden === payload.overridden && derived.estimatedAgents === payload.estimatedAgents
        && derived.estimatedTokens === payload.estimatedTokens
        && derived.tradeoffs.tokens === payload.tradeoffs.tokens
        && derived.tradeoffs.coordination === payload.tradeoffs.coordination
        && derived.launchAuthorized === payload.launchAuthorized;
}
function validateReplayEvent(state, event) {
    if (event.runId !== state.runId)
        throw new ReplayError("event run id changes during replay");
    switch (event.type) {
        case "workRequestCreated":
            if (state.workRequestCreated)
                throw new ReplayError("work request repeated during replay");
            return;
        case "decisionRequired":
            if (!state.workRequestCreated || state.pendingDecision !== null) {
                throw new ReplayError("decision required without an available work request");
            }
            return;
        case "ownerAnswered":
            if (state.pendingDecision === null)
                throw new ReplayError("owner answer without a pending decision");
            if (event.actor !== OWNER_ACTOR)
                throw new ReplayError("non-owner answer during replay");
            if (event.payload.decisionId !== state.pendingDecision.decisionId) {
                throw new ReplayError("owner answer has a mismatched decision id");
            }
            return;
        case "executionModeRecommended":
            if (!state.workRequestCreated || state.executionRecommendation !== null || state.executionApproval !== null)
                throw new ReplayError("invalid execution recommendation during replay");
            {
                // The algorithm is selected by the version recorded in the event, so a
                // pre-Phase-3 event re-derives through unchanged version-1 code and a
                // version-2 event re-derives from its own recorded signal vector and
                // threshold. Replay reads nothing outside the event.
                const payload = event.payload;
                const inputs = { workItems: payload.workItems, maxCrewmatesPerExplorer: payload.maxCrewmatesPerExplorer, perAgentTokenEstimate: payload.perAgentTokenEstimate };
                if (payload.algorithmVersion === undefined) {
                    if (!sameRecommendation(recommendExecutionMode(inputs), payload))
                        throw new ReplayError("execution recommendation is not deterministic");
                    return;
                }
                if (payload.algorithmVersion !== 2)
                    throw new ReplayError("unknown execution selection algorithm version");
                if (!isSelectionSignals(payload.selection))
                    throw new ReplayError("execution recommendation is not deterministic");
                const derived = recommendExecutionModeV2(inputs, payload.selection);
                const fired = payload.firedHardTriggers;
                if (!sameRecommendation(derived, payload)
                    || derived.complexityScore !== payload.complexityScore
                    || derived.recommendedOrchestration !== payload.recommendedOrchestration
                    || !Array.isArray(fired) || derived.firedHardTriggers.length !== fired.length
                    || derived.firedHardTriggers.some((id, index) => id !== fired[index]))
                    throw new ReplayError("execution recommendation is not deterministic");
            }
            return;
        case "executionModeApproved":
        case "executionModeOverridden":
            if (!state.executionRecommendation || state.executionApproval !== null)
                throw new ReplayError("execution approval without a recommendation");
            if (event.actor !== OWNER_ACTOR)
                throw new ReplayError("non-owner execution approval during replay");
            if (event.payload.recommendationEventId !== state.executionRecommendation.eventId)
                throw new ReplayError("execution approval has a mismatched recommendation");
            if (event.type === "executionModeApproved" && (event.payload.selectedMode !== state.executionRecommendation.selectedMode || event.payload.overridden !== false))
                throw new ReplayError("approval does not select recommended mode");
            if (event.type === "executionModeOverridden" && (event.payload.selectedMode === state.executionRecommendation.selectedMode || event.payload.overridden !== true))
                throw new ReplayError("override does not select alternate mode");
            return;
        case "journeyCheckpointRecorded":
            if (!state.workRequestCreated || event.actor !== "bearing")
                throw new ReplayError("invalid journey checkpoint during replay");
            if (event.payload.questionDecisionId !== undefined && (state.pendingDecision !== null || typeof event.payload.question !== "string"))
                throw new ReplayError("invalid journey question checkpoint during replay");
            return;
        case "ownerImprovementApplicationRecorded":
            if (!state.workRequestCreated || event.actor !== OWNER_ACTOR)
                throw new ReplayError("invalid owner improvement application during replay");
            if (state.pendingDecision !== null
                || state.journeyCheckpoint?.stage !== "review"
                || state.journeyCheckpoint.status !== "complete") {
                throw new ReplayError("owner improvement application requires a settled run");
            }
            return;
    }
}
/**
 * Decide a command against the current state. On success returns the new
 * state, the emitted events (empty for an idempotent duplicate), and the
 * recorded outcome. On failure the input state is returned unchanged.
 */
export function decide(state, command, deps) {
    if (!isIssuedRunState(state))
        return fail(state, "malformed_command");
    if (command.schemaVersion !== 1) {
        return fail(state, "future_schema");
    }
    if (command.runId !== state.runId) {
        return fail(state, "malformed_command");
    }
    const contentHash = hashCommand(command);
    const prior = state.outcomes.get(command.commandId);
    if (prior !== undefined) {
        if (prior.contentHash === contentHash) {
            return { ok: true, state, events: [], outcome: prior };
        }
        return fail(state, "conflicting_duplicate");
    }
    if (command.expectedRevision !== state.revision) {
        return fail(state, "stale_revision");
    }
    // Pending consequential decision gates every transition except a matching
    // owner answer for the active decision.
    if (state.pendingDecision !== null) {
        if (command.type !== "recordOwnerAnswer") {
            return fail(state, "pending_decision_blocks");
        }
        if (command.session.actor !== OWNER_ACTOR) {
            return fail(state, "non_owner_answer");
        }
        if (command.payload.decisionId !== state.pendingDecision.decisionId) {
            return fail(state, "wrong_decision_id");
        }
        return succeed(state, command, contentHash, deps, "ownerAnswered", cmdPayload(command));
    }
    switch (command.type) {
        case "createWorkRequest":
            if (state.workRequestCreated)
                return fail(state, "illegal_transition");
            return succeed(state, command, contentHash, deps, "workRequestCreated", cmdPayload(command));
        case "requireDecision":
            if (!state.workRequestCreated)
                return fail(state, "illegal_transition");
            return succeed(state, command, contentHash, deps, "decisionRequired", cmdPayload(command));
        case "recordOwnerAnswer":
            // No pending decision to answer.
            return fail(state, "pending_decision_blocks");
        case "recommendExecutionMode":
            if (!state.workRequestCreated || state.executionRecommendation !== null)
                return fail(state, "illegal_transition");
            // Dispatch by payload shape: a recorded selection vector selects version 2.
            return succeed(state, command, contentHash, deps, "executionModeRecommended", command.payload.selection === undefined
                ? { ...command.payload, ...recommendExecutionMode(command.payload) }
                : { ...command.payload, ...recommendExecutionModeV2(command.payload, command.payload.selection) });
        case "approveExecutionMode":
            if (command.session.actor !== OWNER_ACTOR)
                return fail(state, "non_owner_approval");
            if (!state.executionRecommendation || state.executionApproval !== null)
                return fail(state, "recommendation_missing");
            if (command.payload.recommendationEventId !== state.executionRecommendation.eventId)
                return fail(state, "recommendation_mismatch");
            return succeed(state, command, contentHash, deps, "executionModeApproved", { recommendationEventId: command.payload.recommendationEventId, selectedMode: state.executionRecommendation.recommendedMode, overridden: false });
        case "overrideExecutionMode":
            if (command.session.actor !== OWNER_ACTOR)
                return fail(state, "non_owner_approval");
            if (!state.executionRecommendation || state.executionApproval !== null)
                return fail(state, "recommendation_missing");
            if (command.payload.recommendationEventId !== state.executionRecommendation.eventId)
                return fail(state, "recommendation_mismatch");
            if (command.payload.selectedMode === state.executionRecommendation.recommendedMode)
                return fail(state, "illegal_transition");
            return succeed(state, command, contentHash, deps, "executionModeOverridden", { recommendationEventId: command.payload.recommendationEventId, selectedMode: command.payload.selectedMode, overridden: true });
        case "recordJourneyCheckpoint":
            if (!state.workRequestCreated || command.session.actor !== "bearing")
                return fail(state, "illegal_transition");
            return succeed(state, command, contentHash, deps, "journeyCheckpointRecorded", cmdPayload(command));
        case "recordOwnerImprovementApplication":
            if (command.session.actor !== OWNER_ACTOR)
                return fail(state, "non_owner_approval");
            if (!state.workRequestCreated
                || state.pendingDecision !== null
                || state.journeyCheckpoint?.stage !== "review"
                || state.journeyCheckpoint.status !== "complete")
                return fail(state, "illegal_transition");
            return succeed(state, command, contentHash, deps, "ownerImprovementApplicationRecorded", cmdPayload(command));
    }
}
function succeed(state, command, contentHash, deps, type, payload) {
    const event = buildEvent(state, command, contentHash, deps, type, payload);
    let next = state;
    next = applyEvent(next, event);
    const outcome = next.outcomes.get(command.commandId);
    if (outcome === undefined) {
        // ponytail: unreachable — applyEventWithHash always inserts the outcome.
        throw new Error("bearing: reducer outcome missing after apply");
    }
    return { ok: true, state: next, events: [event], outcome };
}
function buildEvent(state, command, commandContentHash, deps, type, payload) {
    const sequence = state.revision + 1;
    const previousHash = state.events.length > 0 ? state.events[state.events.length - 1].hash : "";
    const body = {
        schemaVersion: 1,
        eventId: deps.nextEventId(),
        runId: state.runId,
        sequence,
        recordedAt: deps.recordedAt,
        type,
        actor: command.session.actor,
        sessionId: command.session.sessionId,
        correlationId: command.correlationId,
        causationId: command.commandId,
        commandContentHash,
        payload,
        evidenceRefs: [],
        previousHash,
    };
    const hash = hashEvent(body);
    return { ...body, hash };
}
function fail(state, reason) {
    return { ok: false, reason, state };
}
function cmdPayload(command) {
    return command.payload;
}
