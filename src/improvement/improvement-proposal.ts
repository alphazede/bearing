import { canonicalStringify, hashEvent } from "../contracts/run.js";

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export type ImprovementMetricId =
  | "coordination-overhead"
  | "first-pass-success"
  | "grading-accuracy"
  | "escaped-defects"
  | "cost-per-accepted-criterion";

export interface MetricSnapshot {
  readonly id: ImprovementMetricId;
  readonly value: number | null;
  readonly numerator: number;
  readonly denominator: number;
  readonly sufficient: boolean;
  readonly confusion?: CanonicalValue;
}

export interface TrialWindow {
  readonly minOccurrences: number;
  readonly minDistinctRuns: number;
  readonly maxAgeDays: number;
  readonly openedAtRef: string;
}

export interface RevertDescriptor {
  readonly surface: string;
  readonly target: CanonicalValue;
  readonly value: CanonicalValue;
}

export interface ProposalRecommendation {
  readonly patternId: string;
  readonly surface: string;
  readonly target: CanonicalValue;
  readonly from: CanonicalValue;
  readonly to: CanonicalValue;
  readonly evidence: {
    readonly recordRefs: readonly string[];
    readonly occurrences: number;
    readonly distinctRuns: number;
  };
  readonly baseline: MetricSnapshot;
  readonly guards: readonly MetricSnapshot[];
  readonly trial: TrialWindow;
  readonly revert: RevertDescriptor;
}

export interface Proposal {
  readonly schemaVersion: 1;
  readonly recommendation: ProposalRecommendation;
  readonly proposalHash: string;
}

export type ProposalFailure =
  | "proposal_malformed"
  | "revert_mismatch"
  | "guard_set_invalid";

export type BuildProposalResult =
  | { readonly ok: true; readonly value: Proposal }
  | { readonly ok: false; readonly reason: ProposalFailure };

export type TrialVerdictStatus = "retain" | "revert" | "inconclusive";
export type TrialVerdictReason =
  | "target_improved"
  | "target_not_improved"
  | "target_insufficient"
  | "guard_regression"
  | "guard_insufficient"
  | "evidence_threshold_not_met";

export interface TrialVerdict {
  readonly status: TrialVerdictStatus;
  readonly prescribedAction: "retain" | "revert";
  readonly reason: TrialVerdictReason;
  readonly occurrences: number;
  readonly distinctRuns: number;
  readonly requiredOccurrences: number;
  readonly requiredDistinctRuns: number;
  readonly ageDays: number;
  readonly targetImprovement: number | null;
  readonly minEffect: number;
  readonly noiseFloor: number;
  readonly guardRegressions: readonly GuardMetricId[];
}

export interface EvaluateTrialInput {
  readonly proposal: Proposal;
  readonly currentTarget: MetricSnapshot;
  readonly currentGuards: readonly MetricSnapshot[];
  readonly occurrences: number;
  readonly distinctRuns: number;
  readonly ageDays: number;
  readonly minEffect: number;
  readonly noiseFloor: number;
}

export type TrialEvaluationFailure =
  | "window_open"
  | "proposal_malformed"
  | "proposal_hash_mismatch"
  | "trial_malformed"
  | "target_metric_mismatch"
  | "guard_set_invalid";

export type EvaluateTrialResult =
  | { readonly ok: true; readonly value: TrialVerdict }
  | { readonly ok: false; readonly reason: TrialEvaluationFailure };

type GuardMetricId =
  | "escaped-defects"
  | "first-pass-success"
  | "cost-per-accepted-criterion";

const METRIC_IDS = new Set<ImprovementMetricId>([
  "coordination-overhead",
  "first-pass-success",
  "grading-accuracy",
  "escaped-defects",
  "cost-per-accepted-criterion",
]);

const GUARD_METRIC_IDS: readonly GuardMetricId[] = Object.freeze([
  "escaped-defects",
  "first-pass-success",
  "cost-per-accepted-criterion",
]);

const HIGHER_IS_BETTER = new Set<ImprovementMetricId>([
  "first-pass-success",
  "grading-accuracy",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasRequiredAndOptionalKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCanonicalValue(value: unknown, seen = new Set<object>()): value is CanonicalValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isCanonicalValue(entry, seen))
    : Object.keys(value).every((key) => (
      Object.hasOwn(value, key) && isCanonicalValue((value as Record<string, unknown>)[key], seen)
    ));
  seen.delete(value);
  return valid;
}

function isMetricSnapshot(value: unknown): value is MetricSnapshot {
  if (!hasRequiredAndOptionalKeys(
    value,
    ["id", "value", "numerator", "denominator", "sufficient"],
    ["confusion"],
  )) return false;
  if (typeof value.id !== "string" || !METRIC_IDS.has(value.id as ImprovementMetricId)) return false;
  if (!isNonNegativeInteger(value.numerator) || !isNonNegativeInteger(value.denominator)) return false;
  if (typeof value.sufficient !== "boolean") return false;
  if (value.sufficient
    ? typeof value.value !== "number" || !Number.isFinite(value.value)
    : value.value !== null) return false;
  return !Object.hasOwn(value, "confusion") || isCanonicalValue(value.confusion);
}

function isTrialWindow(value: unknown): value is TrialWindow {
  return hasRequiredAndOptionalKeys(
    value,
    ["minOccurrences", "minDistinctRuns", "maxAgeDays", "openedAtRef"],
  )
    && isPositiveInteger(value.minOccurrences)
    && isPositiveInteger(value.minDistinctRuns)
    && isPositiveInteger(value.maxAgeDays)
    && typeof value.openedAtRef === "string"
    && value.openedAtRef.length > 0;
}

function isRevertDescriptor(value: unknown): value is RevertDescriptor {
  return hasRequiredAndOptionalKeys(value, ["surface", "target", "value"])
    && typeof value.surface === "string"
    && value.surface.length > 0
    && isCanonicalValue(value.target)
    && isCanonicalValue(value.value);
}

function isEvidence(value: unknown): value is ProposalRecommendation["evidence"] {
  return hasRequiredAndOptionalKeys(value, ["recordRefs", "occurrences", "distinctRuns"])
    && Array.isArray(value.recordRefs)
    && value.recordRefs.every((recordRef) => typeof recordRef === "string" && recordRef.length > 0)
    && isNonNegativeInteger(value.occurrences)
    && isNonNegativeInteger(value.distinctRuns);
}

function guardSetValid(values: readonly MetricSnapshot[]): boolean {
  if (values.length !== GUARD_METRIC_IDS.length) return false;
  const ids = new Set(values.map(({ id }) => id));
  return ids.size === GUARD_METRIC_IDS.length
    && GUARD_METRIC_IDS.every((id) => ids.has(id));
}

function isProposalRecommendation(value: unknown): value is ProposalRecommendation {
  return hasRequiredAndOptionalKeys(value, [
    "patternId",
    "surface",
    "target",
    "from",
    "to",
    "evidence",
    "baseline",
    "guards",
    "trial",
    "revert",
  ])
    && typeof value.patternId === "string"
    && value.patternId.length > 0
    && typeof value.surface === "string"
    && value.surface.length > 0
    && isCanonicalValue(value.target)
    && isCanonicalValue(value.from)
    && isCanonicalValue(value.to)
    && isEvidence(value.evidence)
    && isMetricSnapshot(value.baseline)
    && Array.isArray(value.guards)
    && value.guards.every(isMetricSnapshot)
    && isTrialWindow(value.trial)
    && isRevertDescriptor(value.revert);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(value, key)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalStringify(value)) as T;
}

function sameCanonicalValue(left: CanonicalValue, right: CanonicalValue): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

function proposalBody(recommendation: ProposalRecommendation) {
  return { schemaVersion: 1 as const, recommendation };
}

function hashProposal(recommendation: ProposalRecommendation): string {
  const canonicalBody = canonicalClone(proposalBody(recommendation));
  return hashEvent(canonicalBody as unknown as Parameters<typeof hashEvent>[0]);
}

function recommendationRevertMatches(recommendation: ProposalRecommendation): boolean {
  return recommendation.revert.surface === recommendation.surface
    && sameCanonicalValue(recommendation.revert.target, recommendation.target)
    && sameCanonicalValue(recommendation.revert.value, recommendation.from);
}

export function buildProposal(recommendation: ProposalRecommendation): BuildProposalResult {
  try {
    if (!isProposalRecommendation(recommendation)) {
      return { ok: false, reason: "proposal_malformed" };
    }
    if (!guardSetValid(recommendation.guards)) {
      return { ok: false, reason: "guard_set_invalid" };
    }
    if (!recommendationRevertMatches(recommendation)) {
      return { ok: false, reason: "revert_mismatch" };
    }

    const snapshot = deepFreeze(canonicalClone(recommendation));
    return {
      ok: true,
      value: deepFreeze({
        schemaVersion: 1,
        recommendation: snapshot,
        proposalHash: hashProposal(snapshot),
      }),
    };
  } catch {
    return { ok: false, reason: "proposal_malformed" };
  }
}

function validProposal(value: unknown): value is Proposal {
  return hasRequiredAndOptionalKeys(value, ["schemaVersion", "recommendation", "proposalHash"])
    && value.schemaVersion === 1
    && isProposalRecommendation(value.recommendation)
    && guardSetValid(value.recommendation.guards)
    && recommendationRevertMatches(value.recommendation)
    && typeof value.proposalHash === "string"
    && /^[a-f0-9]{64}$/.test(value.proposalHash);
}

function metricById(
  values: readonly MetricSnapshot[],
  id: ImprovementMetricId,
): MetricSnapshot | undefined {
  return values.find((value) => value.id === id);
}

function improvement(baseline: MetricSnapshot, current: MetricSnapshot): number | null {
  if (!baseline.sufficient || !current.sufficient || baseline.value === null || current.value === null) {
    return null;
  }
  return HIGHER_IS_BETTER.has(baseline.id)
    ? current.value - baseline.value
    : baseline.value - current.value;
}

function verdict(
  input: EvaluateTrialInput,
  status: TrialVerdictStatus,
  reason: TrialVerdictReason,
  targetImprovement: number | null,
  guardRegressions: readonly GuardMetricId[],
): EvaluateTrialResult {
  return {
    ok: true,
    value: deepFreeze({
      status,
      prescribedAction: status === "retain" ? "retain" : "revert",
      reason,
      occurrences: input.occurrences,
      distinctRuns: input.distinctRuns,
      requiredOccurrences: input.proposal.recommendation.trial.minOccurrences,
      requiredDistinctRuns: input.proposal.recommendation.trial.minDistinctRuns,
      ageDays: input.ageDays,
      targetImprovement,
      minEffect: input.minEffect,
      noiseFloor: input.noiseFloor,
      guardRegressions: [...guardRegressions],
    }),
  };
}

export function evaluateTrial(input: EvaluateTrialInput): EvaluateTrialResult {
  try {
    if (!validProposal(input.proposal)) return { ok: false, reason: "proposal_malformed" };
    if (hashProposal(input.proposal.recommendation) !== input.proposal.proposalHash) {
      return { ok: false, reason: "proposal_hash_mismatch" };
    }
    if (!isMetricSnapshot(input.currentTarget)
      || !Array.isArray(input.currentGuards)
      || !input.currentGuards.every(isMetricSnapshot)
      || !isNonNegativeInteger(input.occurrences)
      || !isNonNegativeInteger(input.distinctRuns)
      || !isNonNegativeFinite(input.ageDays)
      || !isNonNegativeFinite(input.minEffect)
      || !isNonNegativeFinite(input.noiseFloor)) {
      return { ok: false, reason: "trial_malformed" };
    }
    if (input.currentTarget.id !== input.proposal.recommendation.baseline.id) {
      return { ok: false, reason: "target_metric_mismatch" };
    }
    if (!guardSetValid(input.currentGuards)) {
      return { ok: false, reason: "guard_set_invalid" };
    }

    const trial = input.proposal.recommendation.trial;
    const enoughEvidence = input.occurrences >= trial.minOccurrences
      && input.distinctRuns >= trial.minDistinctRuns;
    if (!enoughEvidence) {
      if (input.ageDays < trial.maxAgeDays) return { ok: false, reason: "window_open" };
      return verdict(input, "inconclusive", "evidence_threshold_not_met", null, []);
    }

    const guardRegressions: GuardMetricId[] = [];
    let guardInsufficient = false;
    for (const id of GUARD_METRIC_IDS) {
      const baseline = metricById(input.proposal.recommendation.guards, id);
      const current = metricById(input.currentGuards, id);
      if (!baseline || !current) return { ok: false, reason: "guard_set_invalid" };
      const guardImprovement = improvement(baseline, current);
      if (guardImprovement === null) {
        guardInsufficient = true;
      } else if (-guardImprovement > input.noiseFloor) {
        guardRegressions.push(id);
      }
    }

    const targetImprovement = improvement(input.proposal.recommendation.baseline, input.currentTarget);
    if (guardRegressions.length > 0) {
      return verdict(input, "revert", "guard_regression", targetImprovement, guardRegressions);
    }
    if (guardInsufficient) {
      return verdict(input, "revert", "guard_insufficient", targetImprovement, []);
    }
    if (targetImprovement === null) {
      return verdict(input, "revert", "target_insufficient", null, []);
    }
    if (targetImprovement >= input.minEffect) {
      return verdict(input, "retain", "target_improved", targetImprovement, []);
    }
    return verdict(input, "revert", "target_not_improved", targetImprovement, []);
  } catch {
    return { ok: false, reason: "trial_malformed" };
  }
}
