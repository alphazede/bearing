export interface SliceFacts {
  readonly writeSet?: readonly string[];
  readonly interfaceTags?: readonly string[];
  readonly environmentTags?: readonly string[];
  readonly integrationBoundaryTags?: readonly string[];
  readonly parallelSafe?: boolean;
}

export type ConcurrencySignal =
  | "write_set_conflict"
  | "shared_file"
  | "unstable_test"
  | "repeated_integration_failure";

export type ConcurrencyScope = "cross-phase" | "within-phase";
export type ConcurrencyController = "trail-boss" | "explorer";

export interface ConcurrencyPrior {
  readonly phaseId: string;
  readonly cap: number;
  readonly reducedBy?: ConcurrencySignal;
}

export interface AdmissibleConcurrencyInput {
  readonly ceiling: number;
  readonly ownerCap: number;
  readonly independenceCap: number;
  readonly signals: readonly ConcurrencySignal[];
  readonly phaseId: string;
  readonly scope: ConcurrencyScope;
  readonly prior?: ConcurrencyPrior;
}

export interface ConcurrencyDecision {
  readonly cap: number;
  readonly controller: ConcurrencyController;
  readonly reducedBy?: ConcurrencySignal;
}

const CONCURRENCY_SIGNALS: readonly ConcurrencySignal[] = [
  "write_set_conflict",
  "shared_file",
  "unstable_test",
  "repeated_integration_failure",
];

function declaredTags(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && [...value].every((tag) => typeof tag === "string" && tag.length > 0);
}

function disjoint(left: readonly string[], right: readonly string[]): boolean {
  const rightSet = new Set(right);
  return left.every((value) => !rightSet.has(value));
}

export function provenIndependent(a: SliceFacts, b: SliceFacts): boolean {
  if (a.parallelSafe !== true || b.parallelSafe !== true) return false;
  if (!declaredTags(a.writeSet) || !declaredTags(b.writeSet)
    || !declaredTags(a.interfaceTags) || !declaredTags(b.interfaceTags)
    || !declaredTags(a.environmentTags) || !declaredTags(b.environmentTags)
    || !declaredTags(a.integrationBoundaryTags) || !declaredTags(b.integrationBoundaryTags)) {
    return false;
  }

  return disjoint(a.writeSet, b.writeSet)
    && disjoint(a.interfaceTags, b.interfaceTags)
    && disjoint(a.environmentTags, b.environmentTags)
    && disjoint(a.integrationBoundaryTags, b.integrationBoundaryTags);
}

function validCap(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validSignal(value: unknown): value is ConcurrencySignal {
  return typeof value === "string"
    && CONCURRENCY_SIGNALS.some((signal) => signal === value);
}

function assertValidConcurrencyInput(input: AdmissibleConcurrencyInput): void {
  if (!validCap(input.ceiling) || !validCap(input.ownerCap) || !validCap(input.independenceCap)
    || !Array.isArray(input.signals) || input.signals.some((signal) => !validSignal(signal))
    || (input.scope !== "cross-phase" && input.scope !== "within-phase")
    || typeof input.phaseId !== "string" || input.phaseId.length === 0
    || (input.prior !== undefined
      && (typeof input.prior.phaseId !== "string" || input.prior.phaseId.length === 0
        || !validCap(input.prior.cap)
        || (input.prior.reducedBy !== undefined && !validSignal(input.prior.reducedBy))))) {
    throw new TypeError("invalid concurrency input");
  }
}

export function admissibleConcurrency(input: AdmissibleConcurrencyInput): ConcurrencyDecision {
  assertValidConcurrencyInput(input);
  const signal = CONCURRENCY_SIGNALS.find((candidate) => input.signals.includes(candidate));
  const degradedCap = signal === undefined ? Number.MAX_SAFE_INTEGER : 1;
  const unrestricted = Math.min(
    input.ceiling,
    input.ownerCap,
    input.independenceCap,
    degradedCap,
  );
  const samePhasePrior = input.prior?.phaseId === input.phaseId ? input.prior : undefined;
  const cap = Math.min(unrestricted, samePhasePrior?.cap ?? Number.MAX_SAFE_INTEGER);
  const reducedBy = signal
    ?? (samePhasePrior !== undefined && samePhasePrior.cap <= unrestricted
      ? samePhasePrior.reducedBy
      : undefined);

  return {
    cap,
    controller: input.scope === "cross-phase" ? "trail-boss" : "explorer",
    ...(reducedBy === undefined ? {} : { reducedBy }),
  };
}
