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
import {
  HARD_TRIGGER_IDS,
  MAX_COMPLEXITY_SCORE,
  isSelectionSignals,
  type SelectionSignals,
} from "../execution/selection-score.js";
import { EXECUTION_MODES, EXECUTION_ORCHESTRATIONS } from "../execution/execution-mode.js";
import type { FitDecision } from "../journey/repository-fit.js";
import { hasExactKeys, isObject } from "./guards.js";

export const COMMAND_SCHEMA_VERSION = 1 as const;
export const EVENT_SCHEMA_VERSION = 1 as const;
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
] as const;
const PLANNING_FAILURE_VALUES = [
  "REQUIREMENTS_GAP",
  "DESIGN_CONFLICT",
  "RECON_FAILED",
  "MISSING_VALIDATION",
  "UNSAFE_PARALLELISM",
  "OWNER_DECISION_REQUIRED",
] as const;

/** Local browser session reference. `actor` is the authority role. */
interface SessionRef {
  readonly sessionId: string;
  readonly actor: string;
}

// --- Command payload shapes -------------------------------------------------

interface CreateWorkRequestPayload {
  readonly title: string;
  readonly goal: string;
}

/** `consequential` is fixed true: only consequential decisions gate the run. */
interface RequireDecisionPayload {
  readonly decisionId: string;
  readonly question: string;
  readonly consequential: true;
}

interface RecordOwnerAnswerPayload {
  readonly decisionId: string;
  readonly answer: string;
  readonly ownerApprovedContentHash?: string;
}

/**
 * Inputs, not asserted estimates: the aggregate derives the recorded
 * recommendation. `selection` is optional and its presence selects selection
 * algorithm version 2; its absence keeps the frozen version-1 derivation.
 */
interface RecommendExecutionModePayload {
  readonly workItems: number;
  readonly maxCrewmatesPerExplorer: number;
  readonly perAgentTokenEstimate: number;
  readonly selection?: SelectionSignals;
}

const JOURNEY_TOKEN_BUDGET_STATES = ["within_budget", "exhausted"] as const;
const JOURNEY_RECOVERY_OUTCOMES = ["repaired", "stopped"] as const;
export const MAX_JOURNEY_TOKEN_TOTAL = Number.MAX_SAFE_INTEGER;
const MAX_JOURNEY_RECOVERY_ATTEMPTS = 16;

export type JourneyTokenBudgetState = (typeof JOURNEY_TOKEN_BUDGET_STATES)[number];
type JourneyRecoveryStatus = (typeof JOURNEY_RECOVERY_OUTCOMES)[number];

export interface JourneyTokenUsage {
  readonly total: number;
  readonly budget: number;
  readonly state: JourneyTokenBudgetState;
}

export interface JourneyRecoveryOutcome {
  readonly outcome: JourneyRecoveryStatus;
  readonly attempts: number;
}

interface ApproveExecutionModePayload {
  readonly recommendationEventId: string;
}

interface OverrideExecutionModePayload {
  readonly recommendationEventId: string;
  readonly selectedMode: "explorer" | "expedition";
}

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
] as const;

export interface RecordJourneyCheckpointPayload {
  readonly stage: (typeof RECORD_JOURNEY_CHECKPOINT_STAGES)[number];
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
  readonly providerSessionId?: string;
  readonly runtimeStateJson?: string;
  readonly tokenUsage?: JourneyTokenUsage;
  readonly recoveryOutcome?: JourneyRecoveryOutcome;
  readonly verification?: VerificationCheckpointPayload;
  readonly planningState?: string;
  readonly planningFailure?: string;
  readonly repositoryFitDecision?: FitDecision;
  readonly resolvedPlanDirectory?: string;
  readonly improvementProposalRef?: string;
  readonly requirementRefs?: readonly string[];
  readonly review?: readonly ReviewRecord[];
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

interface CreateWorkRequestCommand extends CommandEnvelopeBase {
  readonly type: "createWorkRequest";
  readonly payload: CreateWorkRequestPayload;
}

interface RequireDecisionCommand extends CommandEnvelopeBase {
  readonly type: "requireDecision";
  readonly payload: RequireDecisionPayload;
}

interface RecordOwnerAnswerCommand extends CommandEnvelopeBase {
  readonly type: "recordOwnerAnswer";
  readonly payload: RecordOwnerAnswerPayload;
}

interface RecommendExecutionModeCommand extends CommandEnvelopeBase {
  readonly type: "recommendExecutionMode";
  readonly payload: RecommendExecutionModePayload;
}

interface ApproveExecutionModeCommand extends CommandEnvelopeBase {
  readonly type: "approveExecutionMode";
  readonly payload: ApproveExecutionModePayload;
}

interface OverrideExecutionModeCommand extends CommandEnvelopeBase {
  readonly type: "overrideExecutionMode";
  readonly payload: OverrideExecutionModePayload;
}

interface RecordJourneyCheckpointCommand extends CommandEnvelopeBase {
  readonly type: "recordJourneyCheckpoint";
  readonly payload: RecordJourneyCheckpointPayload;
}

interface RecordOwnerImprovementApplicationCommand extends CommandEnvelopeBase {
  readonly type: "recordOwnerImprovementApplication";
  readonly payload: {
    readonly improvementProposalRef: string;
    readonly externalEvidenceHash: string;
    readonly surface: string;
    readonly targetJson: string;
    readonly valueJson: string;
  };
}

/**
 * Owner-only control-plane provenance for a run created before execution contracts carried
 * role routes. It records the owner's route bindings and nothing else: no stage, status,
 * outcome, ledger, slice, evidence, blocker, or decision field appears in its payload, so it
 * can never move journey progress. The route set itself is validated by the workflow
 * aggregate against `roleRoutesShape`; this boundary only proves envelope shape.
 */
interface ApproveLegacyRoleRoutesCommand extends CommandEnvelopeBase {
  readonly type: "approveLegacyRoleRoutes";
  readonly payload: {
    readonly roleRoutes: readonly LegacyRoleRouteBinding[];
    readonly approvedContentHash: string;
  };
}

/** Structural mirror of `RoleRoute`; the aggregate holds the authoritative role/route rules. */
interface LegacyRoleRouteBinding {
  readonly role: string;
  readonly primary: string;
  readonly fallbacks: readonly string[];
}

interface ApproveLegacyExecutionContractCommand extends CommandEnvelopeBase {
  readonly type: "approveLegacyExecutionContract";
  readonly payload: {
    readonly contract: Readonly<Record<string, unknown>>;
    readonly approvedContentHash: string;
  };
}

export type CommandEnvelopeV1 =
  | CreateWorkRequestCommand
  | RequireDecisionCommand
  | RecordOwnerAnswerCommand
  | RecommendExecutionModeCommand
  | ApproveExecutionModeCommand
  | OverrideExecutionModeCommand
  | RecordJourneyCheckpointCommand
  | RecordOwnerImprovementApplicationCommand
  | ApproveLegacyRoleRoutesCommand
  | ApproveLegacyExecutionContractCommand;

// --- Event envelope ---------------------------------------------------------

export type EventType = "workRequestCreated" | "decisionRequired" | "ownerAnswered" | "executionModeRecommended" | "executionModeApproved" | "executionModeOverridden" | "journeyCheckpointRecorded" | "ownerImprovementApplicationRecorded" | "legacyRoleRoutesApproved" | "legacyExecutionContractApproved";

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

// --- Focus guard runtime provenance -----------------------------------------

/**
 * Runtime identity of the Focus guard that opened a run: a sha256 over the
 * bytes of the loaded Focus validation modules (guard controller, context and
 * completion validation, review gate). Any change to guard validation
 * semantics changes it, so a receipt bound to one build can never be certified
 * by another. Never carries the run's capability or any token material.
 */
const FOCUS_RUNTIME_IDENTITY = /^[a-f0-9]{64}$/;

export function isFocusRuntimeIdentity(value: unknown): value is string {
  return typeof value === "string" && FOCUS_RUNTIME_IDENTITY.test(value);
}

// --- Boundary validation ----------------------------------------------------

type ParseFailure = "malformed" | "future_schema";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: ParseFailure };

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
} as const;

export type VerificationLayer = keyof typeof VERIFICATION_VERDICTS;
export type VerificationVerdict = (typeof VERIFICATION_VERDICTS)[VerificationLayer][number];

type VerificationFindingPriority = "P0" | "P1" | "P2" | "P3";

export interface CompletedSliceEvidence {
  readonly sliceId: string;
  readonly requirementIds: readonly string[];
}

interface ConfirmedFindingEvidence {
  readonly findingRef: string;
  readonly priority: VerificationFindingPriority;
  readonly sliceIds: readonly string[];
}

export interface VerificationCheckpointPayload {
  readonly layer: VerificationLayer;
  readonly verdict: VerificationVerdict;
  readonly rubricVersion?: string;
  readonly findingCount?: number;
  readonly completedSlices?: readonly CompletedSliceEvidence[];
  readonly reviewedSliceIds?: readonly string[];
  readonly confirmedFindings?: readonly ConfirmedFindingEvidence[];
  /**
   * Park Ranger review-repair convergence projection: the run's history of
   * classified P1/P2 findings plus, once the chain of related cycles reaches
   * the threshold, the typed non_convergence condition. A surfaced signal —
   * it never blocks, retries, or changes transitions.
   */
  readonly convergence?: VerificationConvergenceProjection;
}

/** One classified finding as persisted in the convergence projection. */
interface VerificationConvergenceClassifiedFinding {
  readonly fingerprint: string;
  readonly priority: VerificationFindingPriority;
  readonly severityClass: "repair-relevant" | "other";
  readonly subsystem: string;
  readonly relation: "repeated" | "related" | "new";
}

/** The typed convergence condition, present once the related-cycle chain reaches the threshold. */
interface VerificationConvergenceCondition {
  readonly type: "non_convergence";
  readonly cycleCount: number;
  readonly fingerprints: readonly string[];
  readonly subsystem: string;
  readonly findings: readonly VerificationConvergenceClassifiedFinding[];
  readonly action: "consolidate" | "stop";
}

export interface VerificationConvergenceProjection {
  readonly history: {
    readonly tracked: readonly VerificationConvergenceClassifiedFinding[];
    readonly chain: number;
  };
  readonly condition?: VerificationConvergenceCondition;
}

const VERIFICATION_CHECKPOINT_KEYS = [
  "layer",
  "verdict",
  "rubricVersion",
  "findingCount",
  "completedSlices",
  "reviewedSliceIds",
  "confirmedFindings",
  "convergence",
] as const;
/**
 * A rubric version is a short identifier (today `"1"`). `layer` and `verdict` are already bounded by
 * their closed vocabularies; this is the only free-form string left, and the ledger is append-only,
 * so an oversized value can never be removed and permanently inflates the bounded projection.
 */
const MAX_RUBRIC_VERSION = 64;
const MAX_VERIFICATION_ITEMS = 128;
// Convergence projection bounds mirror the guard's own caps in park-ranger.ts:
// 16 cycles, 64 findings per cycle, 1024 tracked findings. Fingerprints and
// subsystems are derived from report fields that are each bounded to 16_384
// characters, so a projected string is at most a few of those joined.
const MAX_CONVERGENCE_CHAIN = 16;
const MAX_CONVERGENCE_CYCLE_FINDINGS = 64;
const MAX_CONVERGENCE_TRACKED = 1024;
const MAX_CONVERGENCE_TEXT = 65_536;
const EXECUTION_SLICE_ID = /^(?:[A-Za-z]+\d+|\d+(?:\.\d+)+)$/;
const FINDING_REF = /^[a-f0-9]{64}$/;

function isVerificationLayer(value: unknown): value is VerificationLayer {
  return isNonEmptyString(value) && Object.hasOwn(VERIFICATION_VERDICTS, value);
}

export function isVerificationVerdict(layer: VerificationLayer, verdict: unknown): verdict is VerificationVerdict {
  return isNonEmptyString(verdict)
    && VERIFICATION_VERDICTS[layer].some((allowed) => allowed === verdict);
}

export function isVerificationCheckpointPayload(v: unknown): v is VerificationCheckpointPayload {
  if (!isObject(v) || !Object.hasOwn(v, "layer") || !Object.hasOwn(v, "verdict")) return false;
  if (Object.keys(v).some((key) => !VERIFICATION_CHECKPOINT_KEYS.some((allowed) => allowed === key))) return false;
  // Optional fields must be OWN properties, not inherited. Object.keys() omits inherited keys, so
  // the allowlist above passes for a prototype-carried value while the destructure below would
  // still read it — the live event would then project metadata that disappears on JSON round-trip
  // and replay. Same in-vs-hasOwn class as the required-key guard.
  if ((v.rubricVersion !== undefined && !Object.hasOwn(v, "rubricVersion"))
    || (v.findingCount !== undefined && !Object.hasOwn(v, "findingCount"))
    || (v.completedSlices !== undefined && !Object.hasOwn(v, "completedSlices"))
    || (v.reviewedSliceIds !== undefined && !Object.hasOwn(v, "reviewedSliceIds"))
    || (v.confirmedFindings !== undefined && !Object.hasOwn(v, "confirmedFindings"))
    || (v.convergence !== undefined && !Object.hasOwn(v, "convergence"))) return false;
  const { layer, verdict, rubricVersion, findingCount, completedSlices, reviewedSliceIds, confirmedFindings, convergence } = v;
  if (!isVerificationLayer(layer)
    || !isVerificationVerdict(layer, verdict)
    || (rubricVersion !== undefined && !isNonEmptyString(rubricVersion, MAX_RUBRIC_VERSION))
    || (findingCount !== undefined && !(typeof findingCount === "number" && Number.isSafeInteger(findingCount) && findingCount >= 0))) return false;
  if (completedSlices !== undefined
    && (!isCanonicalCompletedSlices(completedSlices) || layer !== "validator" || verdict !== "PASS")) return false;
  if (reviewedSliceIds !== undefined
    && (!isCanonicalStringArray(reviewedSliceIds, isExecutionSliceId) || layer !== "park-ranger")) return false;
  if (confirmedFindings !== undefined
    && (!isCanonicalConfirmedFindings(confirmedFindings)
      || layer !== "park-ranger"
      || typeof findingCount !== "number"
      || findingCount !== confirmedFindings.length)) return false;
  if (convergence !== undefined && (!isVerificationConvergenceProjection(convergence) || layer !== "park-ranger")) return false;
  return true;
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

export function isJourneyTokenUsage(value: unknown): value is JourneyTokenUsage {
  if (!isObject(value)
    || !Object.hasOwn(value, "total")
    || !Object.hasOwn(value, "budget")
    || !Object.hasOwn(value, "state")
    || Object.keys(value).some((key) => key !== "total" && key !== "budget" && key !== "state")) return false;
  const { total, budget, state } = value;
  if (!isNonNegativeInt(total)
    || total > MAX_JOURNEY_TOKEN_TOTAL
    || !isNonNegativeInt(budget)
    || budget === 0
    || !JOURNEY_TOKEN_BUDGET_STATES.some((allowed) => allowed === state)) return false;
  return true;
}

export function isJourneyRecoveryOutcome(value: unknown): value is JourneyRecoveryOutcome {
  return isObject(value)
    && Object.hasOwn(value, "outcome")
    && Object.hasOwn(value, "attempts")
    && Object.keys(value).every((key) => key === "outcome" || key === "attempts")
    && JOURNEY_RECOVERY_OUTCOMES.some((allowed) => allowed === value.outcome)
    && isNonNegativeInt(value.attempts)
    && value.attempts > 0
    && value.attempts <= MAX_JOURNEY_RECOVERY_ATTEMPTS;
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

function isNativeDenseArray(v: unknown): v is readonly unknown[] {
  if (!Array.isArray(v)
    || Object.getPrototypeOf(v) !== Array.prototype
    || v.length > MAX_VERIFICATION_ITEMS
    || Object.keys(v).length !== v.length) return false;
  for (let index = 0; index < v.length; index += 1) {
    if (!Object.hasOwn(v, index)) return false;
  }
  return true;
}

function isExecutionSliceId(v: unknown): v is string {
  return isNonEmptyString(v, 128) && EXECUTION_SLICE_ID.test(v);
}

function isPriority(v: unknown): v is VerificationFindingPriority {
  return v === "P0" || v === "P1" || v === "P2" || v === "P3";
}

function isCanonicalStringArray(
  v: unknown,
  predicate: (value: unknown) => value is string,
): v is readonly string[] {
  if (!isNativeDenseArray(v) || v.length === 0 || !v.every(predicate)) return false;
  for (let index = 1; index < v.length; index += 1) {
    if (v[index - 1] >= v[index]) return false;
  }
  return true;
}

function isCanonicalCompletedSlice(v: unknown): v is CompletedSliceEvidence {
  if (!isObject(v)
    || Object.keys(v).length !== 2
    || !Object.hasOwn(v, "sliceId")
    || !Object.hasOwn(v, "requirementIds")) return false;
  return isExecutionSliceId(v.sliceId) && isCanonicalStringArray(v.requirementIds, (value): value is string => {
    return typeof value === "string"
      && value.length <= MAX_REQUIREMENT_REF
      && REQUIREMENT_REF.test(value);
  });
}

function isCanonicalCompletedSlices(v: unknown): v is readonly CompletedSliceEvidence[] {
  if (!isNativeDenseArray(v) || !v.every(isCanonicalCompletedSlice)) return false;
  for (let index = 1; index < v.length; index += 1) {
    if (v[index - 1].sliceId >= v[index].sliceId) return false;
  }
  return true;
}

function isCanonicalConfirmedFinding(v: unknown): v is ConfirmedFindingEvidence {
  if (!isObject(v)
    || Object.keys(v).length !== 3
    || !Object.hasOwn(v, "findingRef")
    || !Object.hasOwn(v, "priority")
    || !Object.hasOwn(v, "sliceIds")) return false;
  return typeof v.findingRef === "string"
    && FINDING_REF.test(v.findingRef)
    && isPriority(v.priority)
    && isCanonicalStringArray(v.sliceIds, isExecutionSliceId);
}

function isConvergenceClassifiedFinding(v: unknown): v is VerificationConvergenceClassifiedFinding {
  if (!isObject(v)
    || Object.keys(v).length !== 5
    || !Object.hasOwn(v, "fingerprint")
    || !Object.hasOwn(v, "priority")
    || !Object.hasOwn(v, "severityClass")
    || !Object.hasOwn(v, "subsystem")
    || !Object.hasOwn(v, "relation")) return false;
  return isNonEmptyString(v.fingerprint, MAX_CONVERGENCE_TEXT)
    && isPriority(v.priority)
    && (v.severityClass === "repair-relevant" || v.severityClass === "other")
    // A subsystem is a path directory and may legitimately be empty for a
    // degenerate path spelling, so it is only length-bounded.
    && typeof v.subsystem === "string"
    && v.subsystem.length <= MAX_CONVERGENCE_TEXT
    && (v.relation === "repeated" || v.relation === "related" || v.relation === "new");
}

function isConvergenceCondition(v: unknown): v is VerificationConvergenceCondition {
  if (!isObject(v)
    || Object.keys(v).length !== 6
    || !Object.hasOwn(v, "type")
    || !Object.hasOwn(v, "cycleCount")
    || !Object.hasOwn(v, "fingerprints")
    || !Object.hasOwn(v, "subsystem")
    || !Object.hasOwn(v, "findings")
    || !Object.hasOwn(v, "action")) return false;
  if (v.type !== "non_convergence"
    || !(typeof v.cycleCount === "number" && Number.isSafeInteger(v.cycleCount) && v.cycleCount >= 1 && v.cycleCount <= MAX_CONVERGENCE_CHAIN)
    || typeof v.subsystem !== "string"
    || v.subsystem.length > MAX_CONVERGENCE_TEXT
    || (v.action !== "consolidate" && v.action !== "stop")) return false;
  return isSortedStringArray(v.fingerprints, MAX_CONVERGENCE_CYCLE_FINDINGS)
    && isSortedFindings(v.findings);
}

function isSortedStringArray(v: unknown, max: number): v is readonly string[] {
  if (!isNativeDenseArray(v) || v.length > max) return false;
  const entries = v as readonly string[];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!Object.hasOwn(entries, index)
      || !isNonEmptyString(entry, MAX_CONVERGENCE_TEXT)
      || (index > 0 && entries[index - 1] >= entry)) return false;
  }
  return true;
}

function isSortedFindings(v: unknown): v is readonly VerificationConvergenceClassifiedFinding[] {
  if (!isNativeDenseArray(v)
    || v.length > MAX_CONVERGENCE_CYCLE_FINDINGS
    || !v.every(isConvergenceClassifiedFinding)) return false;
  const findings = v as readonly VerificationConvergenceClassifiedFinding[];
  for (let index = 1; index < findings.length; index += 1) {
    if (findings[index - 1].fingerprint >= findings[index].fingerprint) return false;
  }
  return true;
}

function isVerificationConvergenceProjection(v: unknown): v is VerificationConvergenceProjection {
  if (!isObject(v)
    || (Object.keys(v).length !== 1 && Object.keys(v).length !== 2)
    || !Object.hasOwn(v, "history")
    || (v.condition !== undefined && !Object.hasOwn(v, "condition"))) return false;
  if (v.condition !== undefined && !isConvergenceCondition(v.condition)) return false;
  const history = v.history;
  if (!isObject(history)
    || Object.keys(history).length !== 2
    || !Object.hasOwn(history, "tracked")
    || !Object.hasOwn(history, "chain")) return false;
  return isNativeDenseArray(history.tracked)
    && history.tracked.length <= MAX_CONVERGENCE_TRACKED
    && history.tracked.every(isConvergenceClassifiedFinding)
    && typeof history.chain === "number"
    && Number.isSafeInteger(history.chain)
    && history.chain >= 0
    && history.chain <= MAX_CONVERGENCE_CHAIN;
}

function isCanonicalConfirmedFindings(v: unknown): v is readonly ConfirmedFindingEvidence[] {
  if (!isNativeDenseArray(v) || !v.every(isCanonicalConfirmedFinding)) return false;
  for (let index = 1; index < v.length; index += 1) {
    if (v[index - 1].findingRef >= v[index].findingRef) return false;
  }
  return true;
}

const MAX_REQUIREMENT_REFS = 128;
const MAX_REQUIREMENT_REF = 128;
const REQUIREMENT_REF = /^(?:AC|RISK)-[A-Z0-9][A-Z0-9.-]*$/;

function isRequirementRefs(v: unknown): v is readonly string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_REQUIREMENT_REFS) return false;
  for (let index = 0; index < v.length; index += 1) {
    const entry = v[index];
    if (!Object.hasOwn(v, index)
      || typeof entry !== "string"
      || entry.length > MAX_REQUIREMENT_REF
      || !REQUIREMENT_REF.test(entry)) return false;
  }
  return true;
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
    case "recordOwnerImprovementApplication":
      if (!isRecordOwnerImprovementApplicationPayload(v.payload)) return { ok: false, reason: "malformed" };
      break;
    case "approveLegacyRoleRoutes":
      if (!isApproveLegacyRoleRoutesPayload(v.payload)) return { ok: false, reason: "malformed" };
      break;
    case "approveLegacyExecutionContract":
      if (!isApproveLegacyExecutionContractPayload(v.payload)) return { ok: false, reason: "malformed" };
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
function isApproveLegacyRoleRoutesPayload(v: unknown): v is ApproveLegacyRoleRoutesCommand["payload"] {
  if (!isObject(v)) return false;
  const keys = Object.keys(v);
  if (keys.length !== 2 || !keys.every((key) => key === "roleRoutes" || key === "approvedContentHash")) return false;
  if (!isHash(v.approvedContentHash)) return false;
  if (!Array.isArray(v.roleRoutes) || v.roleRoutes.length === 0 || v.roleRoutes.length > MAX_EVIDENCE_REFS) return false;
  return v.roleRoutes.every((route, index) => {
    if (!Object.hasOwn(v.roleRoutes as object, index) || !isObject(route)) return false;
    const routeKeys = Object.keys(route);
    return routeKeys.length === 3
      && isNonEmptyString(route.role)
      && isNonEmptyString(route.primary)
      && Array.isArray(route.fallbacks)
      && route.fallbacks.every((item, at) => Object.hasOwn(route.fallbacks as object, at) && isNonEmptyString(item));
  });
}

function isApproveLegacyExecutionContractPayload(v: unknown): v is ApproveLegacyExecutionContractCommand["payload"] {
  if (!isObject(v)) return false;
  const keys = Object.keys(v);
  if (keys.length !== 2 || !keys.every((key) => key === "contract" || key === "approvedContentHash")) return false;
  if (!isHash(v.approvedContentHash)) return false;
  return isObject(v.contract);
}

function isPositiveInt(v: unknown): v is number {
  return isNonNegativeInt(v) && v > 0;
}

function hasRequiredAndOptionalKeys(v: unknown, required: readonly string[], optional: readonly string[]): v is Record<string, unknown> {
  if (!isObject(v)) return false;
  return required.every((key) => Object.hasOwn(v, key))
    && Object.keys(v).every((key) => required.includes(key) || optional.includes(key));
}

/**
 * Structure comes from the selection module, so the producer and this parser
 * cannot disagree about the shape; the bounds are this boundary's own.
 */
function isSelectionSignalsPayload(v: unknown): v is SelectionSignals {
  if (!isSelectionSignals(v)) return false;
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

function isRecommendExecutionModePayload(v: unknown): v is RecommendExecutionModePayload {
  return hasRequiredAndOptionalKeys(v, ["workItems", "maxCrewmatesPerExplorer", "perAgentTokenEstimate"], ["selection"])
    && isPositiveInt(v.workItems) && v.workItems <= MAX_RECOMMENDATION_WORK_ITEMS
    && isPositiveInt(v.maxCrewmatesPerExplorer) && v.maxCrewmatesPerExplorer <= MAX_RECOMMENDATION_CREWMATES
    && isPositiveInt(v.perAgentTokenEstimate) && v.perAgentTokenEstimate <= MAX_RECOMMENDATION_TOKENS
    && (!Object.hasOwn(v, "selection") || isSelectionSignalsPayload(v.selection));
}

function isApproveExecutionModePayload(v: unknown): v is ApproveExecutionModePayload {
  return hasExactKeys(v, ["recommendationEventId"]) && isId(v.recommendationEventId);
}

function isOverrideExecutionModePayload(v: unknown): v is OverrideExecutionModePayload {
  return hasExactKeys(v, ["recommendationEventId", "selectedMode"]) && isId(v.recommendationEventId) && isMode(v.selectedMode);
}

function isRecordJourneyCheckpointPayload(v: unknown): v is RecordJourneyCheckpointPayload {
  if (!isObject(v)) return false;
  const requiredKeys = ["stage", "status", "artifacts"];
  const optionalKeys = ["planDirectory", "question", "questionDecisionId", "reviewBaselineRevision", "lastResultJson", "qaJson", "gatherQuestionsDiscovered", "selectionProvider", "selectionModel", "selectionReasoning", "providerSessionId", "runtimeStateJson", "tokenUsage", "recoveryOutcome", "verification", "planningState", "planningFailure", "ownerApprovedContentHash", "repositoryFitDecision", "resolvedPlanDirectory", "improvementProposalRef", "requirementRefs", "review"];
  if (
    !requiredKeys.every((key) => Object.hasOwn(v, key))
    || Object.keys(v).some((key) => ![...requiredKeys, ...optionalKeys].includes(key))
    || optionalKeys.some((key) => !Object.hasOwn(v, key) && v[key] !== undefined)
  ) return false;
  const ownValue = (key: string): unknown => Object.hasOwn(v, key) ? v[key] : undefined;
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
  return RECORD_JOURNEY_CHECKPOINT_STAGES.includes(v.stage as RecordJourneyCheckpointPayload["stage"]) && statuses.includes(v.status as string) && Array.isArray(v.artifacts) && v.artifacts.length <= 256 && v.artifacts.every((path) => isNonEmptyString(path)) &&
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

export const REVIEW_CLASSES = ["general", "security"] as const;
export type ReviewClass = (typeof REVIEW_CLASSES)[number];

export const REVIEW_VERDICTS = ["PASS", "FAIL", "NEEDS_MORE_EVIDENCE"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** A short, path-blind digest. Raw session identifiers never enter the record. */
const REVIEW_IDENTITY = /^[a-f0-9]{16}$/;
/** Git object names, SHA-1 through SHA-256. */
const REVIEW_REVISION = /^[0-9a-f]{40,64}$/;
const REVIEW_COMMAND_ID = /^(?:CMD|PROC)-[A-Z0-9][A-Z0-9.-]*$/;
const MAX_REVIEW_TEXT = 512;
const MAX_REVIEW_ITEMS = 64;

export interface ReviewCommandEvidence {
  readonly commandId: string;
  readonly status: "passed" | "failed";
  readonly summary: string;
}

export interface ReviewFinding {
  readonly summary: string;
  readonly evidence: string;
}

export interface ReviewRecord {
  readonly reviewClass: ReviewClass;
  readonly verdict: ReviewVerdict;
  readonly contractHash: string;
  readonly reviewedRevision: string;
  readonly scope: readonly string[];
  readonly reviewerIdentity: string;
  readonly implementerIdentities: readonly string[];
  readonly commands: readonly ReviewCommandEvidence[];
  readonly findings: readonly ReviewFinding[];
}

function isReviewIdentity(v: unknown): v is string {
  return typeof v === "string" && REVIEW_IDENTITY.test(v);
}

function isReviewCommandEvidence(v: unknown): v is ReviewCommandEvidence {
  return hasExactKeys(v, ["commandId", "status", "summary"])
    && typeof v.commandId === "string" && REVIEW_COMMAND_ID.test(v.commandId)
    && (v.status === "passed" || v.status === "failed")
    && isNonEmptyString(v.summary, MAX_REVIEW_TEXT);
}

function isReviewFinding(v: unknown): v is ReviewFinding {
  return hasExactKeys(v, ["summary", "evidence"])
    && isNonEmptyString(v.summary, MAX_REVIEW_TEXT)
    && isNonEmptyString(v.evidence, MAX_REVIEW_TEXT);
}

function isReviewCommands(v: unknown): v is readonly ReviewCommandEvidence[] {
  if (!isNativeDenseArray(v) || v.length === 0 || v.length > MAX_REVIEW_ITEMS || !v.every(isReviewCommandEvidence)) return false;
  for (let index = 1; index < v.length; index += 1) {
    if (v[index - 1].commandId >= v[index].commandId) return false;
  }
  return true;
}

/**
 * One review record. The independence and verdict-support rules live here, not
 * only in the write path: a ledger entry that certifies its own implementer, or
 * claims PASS over a failed rerun, is malformed wherever it is read from.
 */
export function isReviewRecord(v: unknown): v is ReviewRecord {
  if (!hasExactKeys(v, [
    "reviewClass", "verdict", "contractHash", "reviewedRevision", "scope",
    "reviewerIdentity", "implementerIdentities", "commands", "findings",
  ])) return false;
  if (!REVIEW_CLASSES.some((allowed) => allowed === v.reviewClass)
    || !REVIEW_VERDICTS.some((allowed) => allowed === v.verdict)
    || !isHash(v.contractHash)
    || typeof v.reviewedRevision !== "string" || !REVIEW_REVISION.test(v.reviewedRevision)
    || !isCanonicalStringArray(v.scope, isExecutionSliceId)
    || !isReviewIdentity(v.reviewerIdentity)
    || !isCanonicalStringArray(v.implementerIdentities, isReviewIdentity)
    || !isReviewCommands(v.commands)
    || !isNativeDenseArray(v.findings) || v.findings.length > MAX_REVIEW_ITEMS || !v.findings.every(isReviewFinding)) return false;
  if (v.implementerIdentities.includes(v.reviewerIdentity)) return false;
  if (v.verdict === "PASS" && v.commands.some((command) => command.status === "failed")) return false;
  return v.verdict === "PASS" || v.findings.length > 0;
}

/**
 * At most one record per class, all bound to the same reviewed revision. A
 * remediation commit moves that revision, so no surviving pass can certify it.
 */
export function isReviewRecords(v: unknown): v is readonly ReviewRecord[] {
  if (!isNativeDenseArray(v) || v.length === 0 || v.length > REVIEW_CLASSES.length || !v.every(isReviewRecord)) return false;
  for (let index = 1; index < v.length; index += 1) {
    if (v[index - 1].reviewClass >= v[index].reviewClass) return false;
  }
  return v.every((record) => record.reviewedRevision === v[0].reviewedRevision);
}

function isRecordOwnerImprovementApplicationPayload(v: unknown): v is RecordOwnerImprovementApplicationCommand["payload"] {
  return hasExactKeys(v, ["improvementProposalRef", "externalEvidenceHash", "surface", "targetJson", "valueJson"])
    && typeof v.improvementProposalRef === "string"
    && /^[a-f0-9]{64}$/.test(v.improvementProposalRef)
    && typeof v.externalEvidenceHash === "string"
    && /^[a-f0-9]{64}$/.test(v.externalEvidenceHash)
    && isNonEmptyString(v.surface, 128)
    && isCanonicalJson(v.targetJson)
    && isCanonicalJson(v.valueJson);
}

function isCanonicalJson(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > MAX_STRING) return false;
  try {
    return canonicalStringify(JSON.parse(v)) === v;
  } catch {
    return false;
  }
}

function isRepositoryFitDecision(v: unknown): v is FitDecision {
  if (hasExactKeys(v, ["outcome"]) && v.outcome === "declined") return true;
  return hasExactKeys(v, ["outcome", "planDirectory", "repository", "decidedAt"])
    && (v.outcome === "confirmed" || v.outcome === "redirected")
    && isNonEmptyString(v.planDirectory)
    && isNonEmptyString(v.repository)
    && isNonEmptyString(v.decidedAt);
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
    case "ownerImprovementApplicationRecorded":
      if (!isRecordOwnerImprovementApplicationPayload(v.payload)) return { ok: false, reason: "malformed" };
      break;
    case "legacyRoleRoutesApproved":
      if (!isApproveLegacyRoleRoutesPayload(v.payload)) return { ok: false, reason: "malformed" };
      break;
    case "legacyExecutionContractApproved":
      if (!isApproveLegacyExecutionContractPayload(v.payload)) return { ok: false, reason: "malformed" };
      break;
    default:
      return { ok: false, reason: "malformed" };
  }
  return { ok: true, value: v as unknown as EventEnvelopeV1 };
}

function isMode(v: unknown): v is (typeof EXECUTION_MODES)[number] {
  return (EXECUTION_MODES as readonly unknown[]).includes(v);
}

/** Emitted in declaration order, never sorted, so replay array equality is stable. */
function isFiredHardTriggerList(v: unknown): boolean {
  if (!Array.isArray(v) || v.length > HARD_TRIGGER_IDS.length) return false;
  let next = 0;
  for (const entry of v) {
    const index = HARD_TRIGGER_IDS.findIndex((id, at) => at >= next && id === entry);
    if (index < 0) return false;
    next = index + 1;
  }
  return true;
}

const V2_RECOMMENDATION_KEYS = ["selection", "algorithmVersion", "complexityScore", "firedHardTriggers", "recommendedOrchestration"] as const;

function isExecutionModeRecommendationPayload(v: unknown): boolean {
  if (!isObject(v)) return false;
  const record = v;
  const present = V2_RECOMMENDATION_KEYS.filter((key) => Object.hasOwn(record, key));
  // Half a version-2 group is a corrupt event, not a lenient upgrade.
  if (present.length !== 0 && present.length !== V2_RECOMMENDATION_KEYS.length) return false;
  if (present.length === V2_RECOMMENDATION_KEYS.length && !(
    record.algorithmVersion === 2
    && isSelectionSignalsPayload(record.selection)
    && isNonNegativeInt(record.complexityScore) && record.complexityScore <= MAX_COMPLEXITY_SCORE
    && isFiredHardTriggerList(record.firedHardTriggers)
    && EXECUTION_ORCHESTRATIONS.includes(record.recommendedOrchestration as (typeof EXECUTION_ORCHESTRATIONS)[number])
    // Trail Boss is a role inside expedition mode; it is never paired with explorer mode.
    && (record.recommendedOrchestration !== "trail-boss" || record.recommendedMode === "expedition")
  )) return false;
  return hasRequiredAndOptionalKeys(record, ["workItems", "maxCrewmatesPerExplorer", "perAgentTokenEstimate", "recommendedMode", "selectedMode", "overridden", "estimatedAgents", "estimatedTokens", "tradeoffs", "launchAuthorized"], V2_RECOMMENDATION_KEYS)
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
