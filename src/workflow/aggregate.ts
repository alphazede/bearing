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
import {
  hashExecutionContractBody,
  hashLegacyRoleRoutes,
  roleRoutesShape,
  type ApprovedExecutionContract,
  type ExecutionContractBody,
  type RoleRoute,
} from "../contracts/execution-contract.js";
import { recommendExecutionMode, recommendExecutionModeV2, type ExecutionMode, type ModeRecommendation } from "../execution/execution-mode.js";
import { isSelectionSignals } from "../execution/selection-score.js";

function extractContractBody(contract: ApprovedExecutionContract): ExecutionContractBody {
  const { contentHash: _hash, ownerApproval: _approval, ...body } = contract;
  return body as ExecutionContractBody;
}

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
  /**
   * Owner-approved role bindings for a run created before execution contracts carried role
   * routes. Control-plane provenance only: it is never consulted by any transition rule and
   * never participates in journey progress. An approved execution contract stays
   * authoritative wherever one resolves.
   */
  readonly legacyRoleRoutes: readonly RoleRoute[] | null;
  /**
   * Owner-approved execution contract for a run created before execution contracts were written
   * to the plan directory. Control-plane provenance only: it never advances journey progress.
   */
  readonly legacyExecutionContract: ApprovedExecutionContract | null;
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
  | "role_routes_invalid"
  | "role_routes_hash_mismatch"
  | "role_routes_already_bound"
  | "execution_contract_invalid"
  | "execution_contract_hash_mismatch"
  | "execution_contract_already_bound"
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
    legacyRoleRoutes: null,
    legacyExecutionContract: null,
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
  let legacyRoleRoutes = state.legacyRoleRoutes;
  let legacyExecutionContract = state.legacyExecutionContract;
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
    case "ownerImprovementApplicationRecorded":
      // Typed evidence is carried by the event; no additional RunState projection required.
      break;
    case "legacyRoleRoutesApproved":
      // Exactly one projected field. `pendingDecision` is deliberately untouched: this event
      // records owner provenance, it never answers or clears a decision.
      legacyRoleRoutes = event.payload.roleRoutes as readonly RoleRoute[];
      break;
    case "legacyExecutionContractApproved":
      legacyExecutionContract = (event.payload.contract as unknown) as ApprovedExecutionContract;
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
    legacyRoleRoutes,
    legacyExecutionContract,
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

/** The eight fields every algorithm version has compared since schema v1. */
function sameRecommendation(derived: ModeRecommendation, payload: Readonly<Record<string, unknown>>): boolean {
  return derived.recommendedMode === payload.recommendedMode && derived.selectedMode === payload.selectedMode
    && derived.overridden === payload.overridden && derived.estimatedAgents === payload.estimatedAgents
    && derived.estimatedTokens === payload.estimatedTokens
    && derived.tradeoffs.tokens === (payload.tradeoffs as { tokens: string }).tokens
    && derived.tradeoffs.coordination === (payload.tradeoffs as { coordination: string }).coordination
    && derived.launchAuthorized === payload.launchAuthorized;
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
        // The algorithm is selected by the version recorded in the event, so a
        // pre-Phase-3 event re-derives through unchanged version-1 code and a
        // version-2 event re-derives from its own recorded signal vector and
        // threshold. Replay reads nothing outside the event.
        const payload = event.payload;
        const inputs = { workItems: payload.workItems as number, maxCrewmatesPerExplorer: payload.maxCrewmatesPerExplorer as number, perAgentTokenEstimate: payload.perAgentTokenEstimate as number };
        if (payload.algorithmVersion === undefined) {
          if (!sameRecommendation(recommendExecutionMode(inputs), payload)) throw new ReplayError("execution recommendation is not deterministic");
          return;
        }
        if (payload.algorithmVersion !== 2) throw new ReplayError("unknown execution selection algorithm version");
        if (!isSelectionSignals(payload.selection)) throw new ReplayError("execution recommendation is not deterministic");
        const derived = recommendExecutionModeV2(inputs, payload.selection);
        const fired = payload.firedHardTriggers;
        if (!sameRecommendation(derived, payload)
          || derived.complexityScore !== payload.complexityScore
          || derived.recommendedOrchestration !== payload.recommendedOrchestration
          || !Array.isArray(fired) || derived.firedHardTriggers.length !== fired.length
          || derived.firedHardTriggers.some((id, index) => id !== fired[index])) throw new ReplayError("execution recommendation is not deterministic");
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
    case "ownerImprovementApplicationRecorded":
      if (!state.workRequestCreated || event.actor !== OWNER_ACTOR) throw new ReplayError("invalid owner improvement application during replay");
      if (state.pendingDecision !== null
        || state.journeyCheckpoint?.stage !== "review"
        || state.journeyCheckpoint.status !== "complete") {
        throw new ReplayError("owner improvement application requires a settled run");
      }
      return;
    case "legacyRoleRoutesApproved":
      if (!state.workRequestCreated || event.actor !== OWNER_ACTOR) throw new ReplayError("invalid legacy role-route approval during replay");
      if (state.legacyRoleRoutes !== null) throw new ReplayError("legacy role routes are already bound");
      if (!roleRoutesShape(event.payload.roleRoutes)) throw new ReplayError("legacy role routes are not a complete registered binding");
      if (event.payload.approvedContentHash !== hashLegacyRoleRoutes(state.runId, event.payload.roleRoutes)) {
        throw new ReplayError("legacy role routes do not match their approved content hash");
      }
      return;
    case "legacyExecutionContractApproved":
      if (!state.workRequestCreated || event.actor !== OWNER_ACTOR) throw new ReplayError("invalid legacy execution-contract approval during replay");
      if (state.legacyExecutionContract !== null) throw new ReplayError("legacy execution contract is already bound");
      if (typeof event.payload.contract !== "object" || event.payload.contract === null) throw new ReplayError("legacy execution contract payload is invalid");
      if (event.payload.approvedContentHash !== hashExecutionContractBody(extractContractBody((event.payload.contract as unknown) as ApprovedExecutionContract))) {
        throw new ReplayError("legacy execution contract does not match its approved content hash");
      }
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

  // Pending consequential decision gates every transition except a matching owner answer for
  // the active decision, and one owner-only command that records control-plane provenance
  // without touching journey progress. `approveLegacyRoleRoutes` and `approveLegacyExecutionContract`
  // are admitted here because they cannot advance, answer, or settle anything: they project
  // control-plane provenance alone and leave `pendingDecision` exactly as they found it. Every other
  // command — including `recordOwnerImprovementApplication` and every journey transition — stays blocked.
  if (state.pendingDecision !== null) {
    if (command.type === "approveLegacyRoleRoutes") {
      return decideLegacyRoleRoutes(state, command, contentHash, deps);
    }
    if (command.type === "approveLegacyExecutionContract") {
      return decideLegacyExecutionContract(state, command, contentHash, deps);
    }
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
      // Dispatch by payload shape: a recorded selection vector selects version 2.
      return succeed(state, command, contentHash, deps, "executionModeRecommended", command.payload.selection === undefined
        ? { ...command.payload, ...recommendExecutionMode(command.payload) }
        : { ...command.payload, ...recommendExecutionModeV2(command.payload, command.payload.selection) });
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
    case "recordOwnerImprovementApplication":
      if (command.session.actor !== OWNER_ACTOR) return fail(state, "non_owner_approval");
      if (!state.workRequestCreated
        || state.pendingDecision !== null
        || state.journeyCheckpoint?.stage !== "review"
        || state.journeyCheckpoint.status !== "complete") return fail(state, "illegal_transition");
      return succeed(state, command, contentHash, deps, "ownerImprovementApplicationRecorded", cmdPayload(command));
    case "approveLegacyRoleRoutes":
      return decideLegacyRoleRoutes(state, command, contentHash, deps);
    case "approveLegacyExecutionContract":
      return decideLegacyExecutionContract(state, command, contentHash, deps);
  }
}

function decideLegacyExecutionContract(
  state: RunState,
  command: Extract<CommandEnvelopeV1, { readonly type: "approveLegacyExecutionContract" }>,
  contentHash: string,
  deps: DecideDeps,
): DecideResult {
  if (command.session.actor !== OWNER_ACTOR) return fail(state, "non_owner_approval");
  if (!state.workRequestCreated) return fail(state, "illegal_transition");
  if (state.legacyExecutionContract !== null) return fail(state, "execution_contract_already_bound");
  const { contract, approvedContentHash } = command.payload;
  const body = extractContractBody((contract as unknown) as ApprovedExecutionContract);
  if (approvedContentHash !== hashExecutionContractBody(body)) {
    return fail(state, "execution_contract_hash_mismatch");
  }
  return succeed(state, command, contentHash, deps, "legacyExecutionContractApproved", {
    contract,
    approvedContentHash,
  });
}

/**
 * Decide the one owner-only role-route binding, whether or not a decision is pending.
 *
 * Every gate is fail-closed and none of them is relaxed by the pending-decision path above:
 * the actor must be the owner, the run must exist, the bindings must be a complete set of
 * registered routes for every required role, and the owner must have signed this exact
 * canonical content for this exact run. The binding is write-once — a second, different
 * approval is refused rather than silently overwriting owner provenance. An identical
 * re-submission under the same command id replays through the outcome map above and emits
 * nothing.
 */
function decideLegacyRoleRoutes(
  state: RunState,
  command: Extract<CommandEnvelopeV1, { readonly type: "approveLegacyRoleRoutes" }>,
  contentHash: string,
  deps: DecideDeps,
): DecideResult {
  if (command.session.actor !== OWNER_ACTOR) return fail(state, "non_owner_approval");
  if (!state.workRequestCreated) return fail(state, "illegal_transition");
  if (state.legacyRoleRoutes !== null) return fail(state, "role_routes_already_bound");
  const { roleRoutes, approvedContentHash } = command.payload;
  if (!roleRoutesShape(roleRoutes)) return fail(state, "role_routes_invalid");
  if (approvedContentHash !== hashLegacyRoleRoutes(state.runId, roleRoutes)) {
    return fail(state, "role_routes_hash_mismatch");
  }
  // The payload is rebuilt from the validated values so no unvalidated key can reach the
  // durable event, and so the recorded bytes are exactly what the approved hash covers.
  return succeed(state, command, contentHash, deps, "legacyRoleRoutesApproved", {
    roleRoutes: roleRoutes.map((route) => ({ role: route.role, primary: route.primary, fallbacks: [...route.fallbacks] })),
    approvedContentHash,
  });
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
