export const METRIC_IDS = Object.freeze([
  "coordination-overhead",
  "first-pass-success",
  "grading-accuracy",
  "escaped-defects",
  "cost-per-accepted-criterion",
] as const);

export type MetricId = (typeof METRIC_IDS)[number];

export interface GradingConfusionCounts {
  readonly truePositive: number;
  readonly trueNegative: number;
  readonly falsePositive: number;
  readonly falseNegative: number;
}

export interface MetricValue {
  readonly id: MetricId;
  readonly value: number | null;
  readonly numerator: number;
  readonly denominator: number;
  readonly sufficient: boolean;
  readonly confusion?: GradingConfusionCounts;
}

/**
 * Structured facts projected from the local run ledgers. The metrics module is
 * deliberately unaware of files, stores, clocks, or any unstructured content.
 */
export interface MetricInputs {
  readonly coordination: readonly {
    readonly estimatedAgents: number;
    readonly workItems: number;
  }[];
  readonly sliceAttempts: readonly {
    readonly sliceRef: string;
    readonly attempt: number;
    readonly status: "complete" | "failed";
  }[];
  readonly grading?: readonly {
    readonly sliceRef: string;
    readonly verdict: "pass" | "fail";
    readonly groundTruth?: "pass" | "fail";
  }[];
  readonly completedSlices: readonly {
    readonly runRef?: string;
    readonly sliceRef: string;
    readonly sequence: number;
    readonly requirementRefs: readonly string[];
  }[];
  readonly confirmedFindings?: readonly {
    readonly sliceRef: string;
    readonly sequence: number;
  }[];
  readonly reviewedSlices?: readonly {
    readonly sliceRef: string;
    readonly sequence: number;
  }[];
  readonly tokenReports?: readonly {
    readonly runRef?: string;
    readonly tokens: number;
  }[];
  readonly tokenCoverageComplete?: boolean;
}

export interface MetricSet {
  readonly coordinationOverhead: MetricValue;
  readonly firstPassSuccess: MetricValue;
  readonly gradingAccuracy: MetricValue & { readonly confusion: GradingConfusionCounts };
  readonly escapedDefects: MetricValue;
  readonly costPerAcceptedCriterion: MetricValue;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return nonNegativeInteger(value) && value > 0;
}

function reference(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function metric(
  id: MetricId,
  numerator: number,
  denominator: number,
  sourceAvailable: boolean,
): MetricValue {
  const sufficient = sourceAvailable && denominator > 0;
  return Object.freeze({
    id,
    numerator,
    denominator,
    sufficient,
    value: sufficient ? numerator / denominator : null,
  });
}

function coordinationOverhead(input: MetricInputs["coordination"]): MetricValue {
  let numerator = 0;
  let denominator = 0;
  for (const observation of input) {
    if (!positiveInteger(observation.estimatedAgents)
      || !nonNegativeInteger(observation.workItems)
      || observation.workItems > observation.estimatedAgents) continue;
    numerator += observation.estimatedAgents - observation.workItems;
    denominator += observation.estimatedAgents;
  }
  return metric("coordination-overhead", numerator, denominator, true);
}

function firstPassSuccess(input: MetricInputs["sliceAttempts"]): MetricValue {
  const firstBySlice = new Map<string, MetricInputs["sliceAttempts"][number]>();
  for (const observation of input) {
    if (!reference(observation.sliceRef)
      || !positiveInteger(observation.attempt)
      || (observation.status !== "complete" && observation.status !== "failed")
      || firstBySlice.has(observation.sliceRef)) continue;
    firstBySlice.set(observation.sliceRef, observation);
  }
  let numerator = 0;
  for (const observation of firstBySlice.values()) {
    if (observation.attempt === 1 && observation.status === "complete") numerator += 1;
  }
  return metric("first-pass-success", numerator, firstBySlice.size, true);
}

function gradingAccuracy(
  input: NonNullable<MetricInputs["grading"]>,
): MetricValue & { readonly confusion: GradingConfusionCounts } {
  let truePositive = 0;
  let trueNegative = 0;
  let falsePositive = 0;
  let falseNegative = 0;

  for (const observation of input) {
    if (!reference(observation.sliceRef)
      || (observation.verdict !== "pass" && observation.verdict !== "fail")
      || !Object.hasOwn(observation, "groundTruth")) continue;
    const groundTruth = observation.groundTruth;
    if (groundTruth !== "pass" && groundTruth !== "fail") continue;

    // A confirmed defect is the positive class. A grader pass contradicted by
    // that later ground truth is therefore a false negative (an escaped miss).
    if (observation.verdict === "fail" && groundTruth === "fail") truePositive += 1;
    else if (observation.verdict === "pass" && groundTruth === "pass") trueNegative += 1;
    else if (observation.verdict === "fail") falsePositive += 1;
    else falseNegative += 1;
  }

  const confusion = Object.freeze({
    truePositive,
    trueNegative,
    falsePositive,
    falseNegative,
  });
  const denominator = truePositive + trueNegative + falsePositive + falseNegative;
  return Object.freeze({
    ...metric("grading-accuracy", truePositive + trueNegative, denominator, true),
    confusion,
  });
}

function acceptedCriteria(input: MetricInputs["completedSlices"]): {
  readonly denominator: number;
  readonly completedAt: ReadonlyMap<string, number>;
  readonly contributingRunRefs: ReadonlySet<string>;
} {
  const completedAt = new Map<string, number>();
  const requirementRefs = new Map<string, ReadonlySet<string>>();
  const contributingRunRefs = new Set<string>();
  for (const completion of input) {
    if (!reference(completion.sliceRef)
      || !nonNegativeInteger(completion.sequence)
      || !Array.isArray(completion.requirementRefs)) continue;
    const refs = new Set(completion.requirementRefs.filter(reference));
    if (refs.size === 0) continue;
    const previous = completedAt.get(completion.sliceRef);
    if (previous !== undefined && previous <= completion.sequence) continue;
    completedAt.set(completion.sliceRef, completion.sequence);
    requirementRefs.set(completion.sliceRef, refs);
    contributingRunRefs.add(completion.runRef ?? "");
  }
  let denominator = 0;
  for (const refs of requirementRefs.values()) denominator += refs.size;
  return { denominator, completedAt, contributingRunRefs };
}

function escapedDefects(
  input: MetricInputs["confirmedFindings"],
  criteria: ReturnType<typeof acceptedCriteria>,
  sourceAvailable: boolean,
): MetricValue {
  let numerator = 0;
  for (const finding of input ?? []) {
    if (!reference(finding.sliceRef) || !nonNegativeInteger(finding.sequence)) continue;
    const completedAt = criteria.completedAt.get(finding.sliceRef);
    if (completedAt !== undefined && finding.sequence > completedAt) numerator += 1;
  }
  return metric("escaped-defects", numerator, criteria.denominator, sourceAvailable);
}

function costPerAcceptedCriterion(
  input: MetricInputs["tokenReports"],
  criteria: ReturnType<typeof acceptedCriteria>,
  coverageComplete: boolean,
): MetricValue {
  let numerator = 0;
  const coveredRunRefs = new Set<string>();
  let valid = Array.isArray(input) && coverageComplete;
  for (const report of input ?? []) {
    if (!nonNegativeInteger(report.tokens)
      || report.tokens > Number.MAX_SAFE_INTEGER - numerator) {
      valid = false;
      continue;
    }
    numerator += report.tokens;
    coveredRunRefs.add(report.runRef ?? "");
  }
  const complete = valid
    && [...criteria.contributingRunRefs].every((runRef) => coveredRunRefs.has(runRef));
  return metric("cost-per-accepted-criterion", numerator, criteria.denominator, complete);
}

/** Pure computation of the five R6.3 metrics over structured ledger facts. */
export function computeMetrics(input: MetricInputs): MetricSet {
  const criteria = acceptedCriteria(input.completedSlices);
  const grading = Object.hasOwn(input, "grading") && Array.isArray(input.grading)
    ? input.grading
    : [];
  const findingSignalsAvailable = Object.hasOwn(input, "confirmedFindings")
    && Array.isArray(input.confirmedFindings);
  const reviewed = new Set((input.reviewedSlices ?? [])
    .filter((entry) => reference(entry.sliceRef) && nonNegativeInteger(entry.sequence))
    .map((entry) => entry.sliceRef));
  const reviewCoverageAvailable = criteria.completedAt.size > 0
    && [...criteria.completedAt.keys()].every((sliceRef) => reviewed.has(sliceRef));
  return Object.freeze({
    coordinationOverhead: coordinationOverhead(input.coordination),
    firstPassSuccess: firstPassSuccess(input.sliceAttempts),
    gradingAccuracy: gradingAccuracy(grading),
    escapedDefects: escapedDefects(
      findingSignalsAvailable ? input.confirmedFindings : [],
      criteria,
      findingSignalsAvailable && reviewCoverageAvailable,
    ),
    costPerAcceptedCriterion: costPerAcceptedCriterion(
      input.tokenReports,
      criteria,
      input.tokenCoverageComplete !== false,
    ),
  });
}
