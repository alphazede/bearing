/**
 * Pure WorkflowAggregate reducer for a Bearing run.
 *
 * No time, random, filesystem, network, or mutable globals: identifiers,
 * timestamps, and hashes are injected (`DecideDeps`) or computed from inputs.
 * The reducer owns legal transitions only; persistence, delivery, and adapter
 * behavior live elsewhere.
 */
import {
  type CommandEnvelopeV1,
  type EventEnvelopeV1,
  type EventType,
  type RecordJourneyCheckpointPayload,
  hashCommand,
  hashEvent,
} from "../contracts/run.js";
import { recommendExecutionMode, type ExecutionMode, type ModeRecommendation } from "../execution/execution-mode.js";

const issuedStates = new WeakSet<object>();
const durableEvidence = new WeakSet<object>();
const DURABLE_EVIDENCE: unique symbol = Symbol("durable-owner-evidence");

export interface DurableOwnerEvidence {
  readonly kind: "owner-approval" | "owner-override";
  readonly recordedBy: "owner";
  readonly durable: true;
  readonly recordId: string;
  readonly recommendationEventId: string;
  readonly selectedMode: ExecutionMode;
  readonly [DURABLE_EVIDENCE]: true;
}

function issueRunState(state: RunState): RunState {
  issuedStates.add(state);
  return state;
}

export function isIssuedRunState(value: unknown): value is RunState {
  return typeof value === "object" && value !== null && issuedStates.has(value);
}

function mintDurableOwnerEvidence(
  kind: DurableOwnerEvidence["kind"], recordId: string, recommendationEventId: string, selectedMode: ExecutionMode,
): DurableOwnerEvidence {
  const evidence = Object.freeze({ kind, recordedBy: "owner" as const, durable: true as const, recordId, recommendationEventId, selectedMode, [DURABLE_EVIDENCE]: true as const });
  durableEvidence.add(evidence);
  return evidence;
}

export function isDurableOwnerEvidence(value: unknown): value is DurableOwnerEvidence {
  return typeof value === "object" && value !== null && durableEvidence.has(value) && Object.isFrozen(value);
}

export function durableOwnerEvidence(state: unknown): DurableOwnerEvidence | undefined {
  return isIssuedRunState(state) && state.executionApproval && state.executionRecommendation
    ? mintDurableOwnerEvidence(state.executionApproval.kind, state.executionApproval.eventId, state.executionRecommendation.eventId, state.executionApproval.selectedMode)
    : undefined;
}

/** Active consequential decision that gates all other transitions. */
export interface PendingDecision {
  readonly decisionId: string;
  readonly question: string;
}

/** Recorded outcome of an accepted command, kept for idempotent replay. */
export interface CommandOutcome {
  readonly commandId: string;
  readonly contentHash: string;
  readonly eventIds: readonly string[];
}

/** Immutable run state value. `revision` equals `events.length`. */
export interface RunState {
  readonly runId: string;
  readonly revision: number;
  readonly events: readonly EventEnvelopeV1[];
  readonly outcomes: ReadonlyMap<string, CommandOutcome>;
  readonly pendingDecision: PendingDecision | null;
  readonly workRequestCreated: boolean;
  readonly executionRecommendation: (ModeRecommendation & { readonly eventId: string }) | null;
  readonly executionApproval: { readonly eventId: string; readonly kind: DurableOwnerEvidence["kind"]; readonly selectedMode: "explorer" | "expedition" } | null;
  readonly journeyCheckpoint: (RecordJourneyCheckpointPayload & { readonly eventId: string }) | null;
}

/** Injected pure suppliers so the reducer stays deterministic and side-effect free. */
export interface DecideDeps {
  readonly recordedAt: string;
  /** Called once per emitted event; must return a unique opaque id. */
  readonly nextEventId: () => string;
}

export type DecideFailure =
  | "malformed_command"
  | "future_schema"
  | "conflicting_duplicate"
  | "stale_revision"
  | "pending_decision_blocks"
  | "wrong_decision_id"
  | "non_owner_answer"
  | "non_owner_approval"
  | "recommendation_missing"
  | "recommendation_mismatch"
  | "illegal_transition";

export type DecideResult =
  | {
      readonly ok: true;
      readonly state: RunState;
      readonly events: readonly EventEnvelopeV1[];
      readonly outcome: CommandOutcome;
    }
  | { readonly ok: false; readonly reason: DecideFailure; readonly state: RunState };

const OWNER_ACTOR = "owner";

export class ReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayError";
  }
}

export function initialRunState(runId: string): RunState {
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
function applyEvent(state: RunState, event: EventEnvelopeV1): RunState {
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
        decisionId: event.payload.decisionId as string,
        question: event.payload.question as string,
      };
      break;
    case "ownerAnswered":
      pendingDecision = null;
      break;
    case "executionModeRecommended":
      executionRecommendation = { ...event.payload as unknown as ModeRecommendation, eventId: event.eventId };
      break;
    case "executionModeApproved":
    case "executionModeOverridden":
      executionApproval = { eventId: event.eventId, kind: event.type === "executionModeApproved" ? "owner-approval" : "owner-override", selectedMode: event.payload.selectedMode as "explorer" | "expedition" };
      break;
    case "journeyCheckpointRecorded":
      journeyCheckpoint = { ...event.payload as unknown as RecordJourneyCheckpointPayload, eventId: event.eventId };
      if (typeof event.payload.question === "string" && typeof event.payload.questionDecisionId === "string") {
        pendingDecision = { decisionId: event.payload.questionDecisionId, question: event.payload.question };
      }
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
export function replay(events: readonly EventEnvelopeV1[]): RunState {
  const runId = events.length > 0 ? events[0].runId : "";
  let state = initialRunState(runId);
  for (const event of events) {
    validateReplayEvent(state, event);
    state = applyEvent(state, event);
  }
  return state;
}

function validateReplayEvent(state: RunState, event: EventEnvelopeV1): void {
  if (event.runId !== state.runId) throw new ReplayError("event run id changes during replay");
  switch (event.type) {
    case "workRequestCreated":
      if (state.workRequestCreated) throw new ReplayError("work request repeated during replay");
      return;
    case "decisionRequired":
      if (!state.workRequestCreated || state.pendingDecision !== null) {
        throw new ReplayError("decision required without an available work request");
      }
      return;
    case "ownerAnswered":
      if (state.pendingDecision === null) throw new ReplayError("owner answer without a pending decision");
      if (event.actor !== OWNER_ACTOR) throw new ReplayError("non-owner answer during replay");
      if (event.payload.decisionId !== state.pendingDecision.decisionId) {
        throw new ReplayError("owner answer has a mismatched decision id");
      }
      return;
    case "executionModeRecommended":
      if (!state.workRequestCreated || state.executionRecommendation !== null || state.executionApproval !== null) throw new ReplayError("invalid execution recommendation during replay");
      {
        const payload = event.payload;
        const derived = recommendExecutionMode({ workItems: payload.workItems as number, maxCrewmatesPerExplorer: payload.maxCrewmatesPerExplorer as number, perAgentTokenEstimate: payload.perAgentTokenEstimate as number });
        if (derived.recommendedMode !== payload.recommendedMode || derived.selectedMode !== payload.selectedMode || derived.overridden !== payload.overridden || derived.estimatedAgents !== payload.estimatedAgents || derived.estimatedTokens !== payload.estimatedTokens || derived.tradeoffs.tokens !== (payload.tradeoffs as { tokens: string }).tokens || derived.tradeoffs.coordination !== (payload.tradeoffs as { coordination: string }).coordination || derived.launchAuthorized !== payload.launchAuthorized) throw new ReplayError("execution recommendation is not deterministic");
      }
      return;
    case "executionModeApproved":
    case "executionModeOverridden":
      if (!state.executionRecommendation || state.executionApproval !== null) throw new ReplayError("execution approval without a recommendation");
      if (event.actor !== OWNER_ACTOR) throw new ReplayError("non-owner execution approval during replay");
      if (event.payload.recommendationEventId !== state.executionRecommendation.eventId) throw new ReplayError("execution approval has a mismatched recommendation");
      if (event.type === "executionModeApproved" && (event.payload.selectedMode !== state.executionRecommendation.selectedMode || event.payload.overridden !== false)) throw new ReplayError("approval does not select recommended mode");
      if (event.type === "executionModeOverridden" && (event.payload.selectedMode === state.executionRecommendation.selectedMode || event.payload.overridden !== true)) throw new ReplayError("override does not select alternate mode");
      return;
    case "journeyCheckpointRecorded":
      if (!state.workRequestCreated || event.actor !== "bearing") throw new ReplayError("invalid journey checkpoint during replay");
      if (event.payload.questionDecisionId !== undefined && (state.pendingDecision !== null || typeof event.payload.question !== "string")) throw new ReplayError("invalid journey question checkpoint during replay");
      return;
  }
}

/**
 * Decide a command against the current state. On success returns the new
 * state, the emitted events (empty for an idempotent duplicate), and the
 * recorded outcome. On failure the input state is returned unchanged.
 */
export function decide(
  state: RunState,
  command: CommandEnvelopeV1,
  deps: DecideDeps,
): DecideResult {
  if (!isIssuedRunState(state)) return fail(state, "malformed_command");
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
      if (state.workRequestCreated) return fail(state, "illegal_transition");
      return succeed(state, command, contentHash, deps, "workRequestCreated", cmdPayload(command));
    case "requireDecision":
      if (!state.workRequestCreated) return fail(state, "illegal_transition");
      return succeed(state, command, contentHash, deps, "decisionRequired", cmdPayload(command));
    case "recordOwnerAnswer":
      // No pending decision to answer.
      return fail(state, "pending_decision_blocks");
    case "recommendExecutionMode":
      if (!state.workRequestCreated || state.executionRecommendation !== null) return fail(state, "illegal_transition");
      return succeed(state, command, contentHash, deps, "executionModeRecommended", { ...command.payload, ...recommendExecutionMode(command.payload) });
    case "approveExecutionMode":
      if (command.session.actor !== OWNER_ACTOR) return fail(state, "non_owner_approval");
      if (!state.executionRecommendation || state.executionApproval !== null) return fail(state, "recommendation_missing");
      if (command.payload.recommendationEventId !== state.executionRecommendation.eventId) return fail(state, "recommendation_mismatch");
      return succeed(state, command, contentHash, deps, "executionModeApproved", { recommendationEventId: command.payload.recommendationEventId, selectedMode: state.executionRecommendation.recommendedMode, overridden: false });
    case "overrideExecutionMode":
      if (command.session.actor !== OWNER_ACTOR) return fail(state, "non_owner_approval");
      if (!state.executionRecommendation || state.executionApproval !== null) return fail(state, "recommendation_missing");
      if (command.payload.recommendationEventId !== state.executionRecommendation.eventId) return fail(state, "recommendation_mismatch");
      if (command.payload.selectedMode === state.executionRecommendation.recommendedMode) return fail(state, "illegal_transition");
      return succeed(state, command, contentHash, deps, "executionModeOverridden", { recommendationEventId: command.payload.recommendationEventId, selectedMode: command.payload.selectedMode, overridden: true });
    case "recordJourneyCheckpoint":
      if (!state.workRequestCreated || command.session.actor !== "bearing") return fail(state, "illegal_transition");
      return succeed(state, command, contentHash, deps, "journeyCheckpointRecorded", cmdPayload(command));
  }
}

function succeed(
  state: RunState,
  command: CommandEnvelopeV1,
  contentHash: string,
  deps: DecideDeps,
  type: EventType,
  payload: Readonly<Record<string, unknown>>,
): DecideResult {
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

function buildEvent(
  state: RunState,
  command: CommandEnvelopeV1,
  commandContentHash: string,
  deps: DecideDeps,
  type: EventType,
  payload: Readonly<Record<string, unknown>>,
): EventEnvelopeV1 {
  const sequence = state.revision + 1;
  const previousHash = state.events.length > 0 ? state.events[state.events.length - 1].hash : "";
  const body = {
    schemaVersion: 1 as const,
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
    evidenceRefs: [] as readonly string[],
    previousHash,
  };
  const hash = hashEvent(body);
  return { ...body, hash };
}

function fail(state: RunState, reason: DecideFailure): DecideResult {
  return { ok: false, reason, state };
}

function cmdPayload(command: CommandEnvelopeV1): Readonly<Record<string, unknown>> {
  return command.payload as unknown as Readonly<Record<string, unknown>>;
}
