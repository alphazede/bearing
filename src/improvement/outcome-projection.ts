import {
  isJourneyRecoveryOutcome,
  isJourneyTokenUsage,
  isVerificationCheckpointPayload,
  type EventEnvelopeV1,
} from "../contracts/run.js";
import {
  CONCURRENCY_SIGNALS,
  RETRY_OUTCOMES,
  parseRuntimeState,
  type RetryLedgerEntry,
} from "../contracts/runtime-state.js";
import { EXECUTION_MODES } from "../execution/execution-mode.js";
import type { Role } from "../profile/profile.js";
import type { ReasoningTier } from "../profile/reasoning-policy.js";

export const MAX_OUTCOME_RECORDS_PER_RUN = 1_000;
export const MAX_OUTCOME_PATH_REFS = 16;

export const OUTCOME_SIGNALS = Object.freeze([
  "validation_failure",
  "retry",
  "grader_score",
  "park_ranger_finding",
  "park_ranger_review",
  "slice_completion",
  "surveyor_failure",
  "reasoning_effectiveness",
  "concurrency_conflict",
  "coordination",
  "token_usage",
  "recovery",
] as const);

export const OUTCOME_CODES = Object.freeze({
  validation_failure: Object.freeze([
    "REQUIREMENTS_GAP",
    "DESIGN_CONFLICT",
    "RECON_FAILED",
    "MISSING_VALIDATION",
    "UNSAFE_PARALLELISM",
    "OWNER_DECISION_REQUIRED",
    "git_state",
    "path_outside_write_set",
    "artifact_missing",
    "evidence_invalid",
    "no_product_change",
  ] as const),
  retry: Object.freeze([...RETRY_OUTCOMES]),
  grader_score: Object.freeze(["strong", "acceptable", "weak"] as const),
  park_ranger_finding: Object.freeze(["P0", "P1", "P2", "P3"] as const),
  park_ranger_review: Object.freeze(["complete"] as const),
  slice_completion: Object.freeze(["complete"] as const),
  surveyor_failure: Object.freeze(["failed", "blocked", "deviated"] as const),
  reasoning_effectiveness: Object.freeze(["complete", "failed"] as const),
  concurrency_conflict: Object.freeze([...CONCURRENCY_SIGNALS]),
  coordination: Object.freeze([...EXECUTION_MODES]),
  token_usage: Object.freeze(["within_budget", "exhausted"] as const),
  recovery: Object.freeze(["repaired", "stopped"] as const),
} as const);

export type OutcomeSignal = (typeof OUTCOME_SIGNALS)[number];
export type OutcomeCode<S extends OutcomeSignal = OutcomeSignal> =
  (typeof OUTCOME_CODES)[S][number];

interface OutcomeRecordBase {
  readonly schemaVersion: 1;
  readonly runRef: string;
  readonly sliceRef?: string;
  readonly recordedAt: string;
  readonly role?: Role;
  readonly reasoningTier?: ReasoningTier;
  readonly provider?: string;
  readonly attempt?: number;
  readonly fingerprintRef?: string;
  readonly pathRefs?: readonly string[];
}

export type OutcomeRecord = {
  [S in OutcomeSignal]: Readonly<OutcomeRecordBase & {
    readonly signal: S;
    readonly code: OutcomeCode<S>;
  } & (S extends "coordination"
    ? { readonly workItemCount: number; readonly estimatedAgents: number }
    : S extends "concurrency_conflict"
      ? { readonly value: number }
      : S extends "slice_completion"
        ? { readonly sliceRef: string; readonly sequence: number; readonly requirementRefs: readonly string[] }
        : S extends "park_ranger_review"
          ? { readonly sliceRef: string; readonly sequence: number }
          : S extends "park_ranger_finding"
            ? { readonly sliceRef: string; readonly sequence: number; readonly findingRef: string }
            : S extends "token_usage"
              ? { readonly tokens: number; readonly budget: number }
              : S extends "recovery"
                ? { readonly attempts: number }
          : {})>;
}[OutcomeSignal];

export interface ProjectOutcomesInput {
  readonly runId: string;
  readonly events: readonly EventEnvelopeV1[];
  readonly digest: (value: string) => string;
}

const DIGEST = /^[a-f0-9]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_SMALL_COUNT = 1_000_000;
const EMPTY_OUTCOMES: readonly OutcomeRecord[] = Object.freeze([]);

function object(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(value: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function code<S extends OutcomeSignal>(
  signal: S,
  value: unknown,
): value is OutcomeCode<S> {
  return typeof value === "string"
    && (OUTCOME_CODES[signal] as readonly string[]).some((allowed) => allowed === value);
}

function recordedAt(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === (
    value.includes(".") ? value : value.replace("Z", ".000Z")
  );
}

function smallCount(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_SMALL_COUNT;
}

function digest(value: string, digester: ProjectOutcomesInput["digest"]): string | undefined {
  try {
    const reference = digester(value);
    return DIGEST.test(reference) ? reference : undefined;
  } catch {
    return undefined;
  }
}

type OutcomeRecordDraft<S extends OutcomeSignal> = OutcomeRecordBase & {
  readonly signal: S;
  readonly code: OutcomeCode<S>;
} & (S extends "coordination"
  ? { readonly workItemCount: number; readonly estimatedAgents: number }
  : S extends "concurrency_conflict"
    ? { readonly value: number }
    : S extends "slice_completion"
      ? { readonly sliceRef: string; readonly sequence: number; readonly requirementRefs: readonly string[] }
      : S extends "park_ranger_review"
      ? { readonly sliceRef: string; readonly sequence: number }
      : S extends "park_ranger_finding"
        ? { readonly sliceRef: string; readonly sequence: number; readonly findingRef: string }
        : S extends "token_usage"
          ? { readonly tokens: number; readonly budget: number }
          : S extends "recovery"
            ? { readonly attempts: number }
        : {});

function freezeRecord<S extends OutcomeSignal>(
  draft: OutcomeRecordDraft<S>,
): OutcomeRecord {
  const pathRefs = Object.hasOwn(draft, "pathRefs") ? draft.pathRefs : undefined;
  const record = pathRefs === undefined
    ? { ...draft }
    : { ...draft, pathRefs: Object.freeze([...pathRefs].slice(0, MAX_OUTCOME_PATH_REFS)) };
  return Object.freeze(record) as OutcomeRecord;
}

function retrySignature(entry: RetryLedgerEntry): string {
  return `${entry.fingerprint}\u0000${entry.warrant ?? ""}\u0000${entry.reasoningTier}\u0000${entry.outcome}`;
}

/**
 * Runtime retry state is cumulative. Find the largest previous-suffix/current-prefix overlap so a
 * checkpoint replay does not turn one retry into many outcome records. The same rule also handles
 * the bounded runtime ledger dropping old entries from its front.
 */
function appendedRetryOffset(
  previous: readonly string[],
  current: readonly string[],
  initialized: boolean,
): number {
  if (!initialized) return 0;
  for (let size = Math.min(previous.length, current.length); size > 0; size -= 1) {
    const previousStart = previous.length - size;
    if (current.slice(0, size).every((value, index) => value === previous[previousStart + index])) {
      return size;
    }
  }
  return 0;
}

function concurrencySignature(value: {
  readonly admittedLanes: readonly string[];
  readonly cap: number;
  readonly controller: "trail-boss" | "explorer";
  readonly reducedBy?: string;
} | undefined): string {
  if (value === undefined) return "";
  return JSON.stringify([
    value.cap,
    value.controller,
    Object.hasOwn(value, "reducedBy") ? value.reducedBy : null,
    value.admittedLanes,
  ]);
}

function tokenSeriesPoisoned(events: readonly EventEnvelopeV1[]): boolean {
  let initialized = false;
  let previousTotal = 0;
  let previousBudget = 0;
  let previousState: "within_budget" | "exhausted" = "within_budget";
  for (const event of events) {
    if (event.type !== "journeyCheckpointRecorded"
      || !object(event.payload)
      || !Object.hasOwn(event.payload, "tokenUsage")) continue;
    const tokenUsage = own(event.payload, "tokenUsage");
    if (!isJourneyTokenUsage(tokenUsage)) return true;
    if (initialized
      && (tokenUsage.budget !== previousBudget
        || tokenUsage.total < previousTotal
        || (tokenUsage.total === previousTotal
          && previousState === "within_budget"
          && tokenUsage.state === "exhausted"))) return true;
    const invocationTokens = initialized ? tokenUsage.total - previousTotal : tokenUsage.total;
    if ((!initialized || tokenUsage.total > previousTotal)
      && tokenUsage.state === "exhausted"
      && invocationTokens <= tokenUsage.budget) return true;
    initialized = true;
    previousTotal = tokenUsage.total;
    previousBudget = tokenUsage.budget;
    previousState = tokenUsage.state;
  }
  return false;
}

/** Pure, bounded projection over already-validated local ledger envelopes. */
export function projectOutcomes(input: ProjectOutcomesInput): readonly OutcomeRecord[] {
  const runRef = digest(input.runId, input.digest);
  if (runRef === undefined) return EMPTY_OUTCOMES;

  const records: OutcomeRecord[] = [];
  let retryInitialized = false;
  let previousRetrySignatures: readonly string[] = [];
  let concurrencyInitialized = false;
  let previousConcurrencySignature = "";
  let tokenUsageInitialized = false;
  let previousTokenTotal = 0;
  const tokenProjectionPoisoned = tokenSeriesPoisoned(input.events);
  let previousRecoverySignature: string | undefined;
  let previousRecoveryCommandRef: string | undefined;
  const sliceRefCache = new Map<string, string | undefined>();
  const completedSliceIds = new Set<string>();
  const findingRelations = new Set<string>();
  const reviewedSliceIds = new Set<string>();
  const sliceRefFor = (rawSliceId: string): string | undefined => {
    if (sliceRefCache.has(rawSliceId)) return sliceRefCache.get(rawSliceId);
    const reference = digest(`slice\u0000${rawSliceId}`, input.digest);
    sliceRefCache.set(rawSliceId, reference);
    return reference;
  };
  const append = <S extends OutcomeSignal>(draft: OutcomeRecordDraft<S>): boolean => {
    if (records.length >= MAX_OUTCOME_RECORDS_PER_RUN) return false;
    records.push(freezeRecord(draft));
    return records.length < MAX_OUTCOME_RECORDS_PER_RUN;
  };

  for (const event of input.events) {
    if (records.length >= MAX_OUTCOME_RECORDS_PER_RUN) break;
    if (!recordedAt(event.recordedAt) || !object(event.payload)) continue;

    if (event.type === "executionModeRecommended") {
      const recommendedMode = own(event.payload, "recommendedMode");
      const workItems = own(event.payload, "workItems");
      const estimatedAgents = own(event.payload, "estimatedAgents");
      if (
        code("coordination", recommendedMode)
        && smallCount(workItems)
        && smallCount(estimatedAgents)
      ) {
        append({
          schemaVersion: 1,
          runRef,
          recordedAt: event.recordedAt,
          signal: "coordination",
          code: recommendedMode,
          workItemCount: workItems,
          estimatedAgents,
        });
      }
      continue;
    }

    if (event.type !== "journeyCheckpointRecorded") continue;

    const tokenUsage = own(event.payload, "tokenUsage");
    if (!tokenProjectionPoisoned && isJourneyTokenUsage(tokenUsage) && code("token_usage", tokenUsage.state)) {
      if (!tokenUsageInitialized || tokenUsage.total > previousTokenTotal) {
      append({
        schemaVersion: 1,
        runRef,
        recordedAt: event.recordedAt,
        signal: "token_usage",
        code: tokenUsage.state,
        tokens: tokenUsageInitialized ? tokenUsage.total - previousTokenTotal : tokenUsage.total,
        budget: tokenUsage.budget,
      });
      tokenUsageInitialized = true;
      previousTokenTotal = tokenUsage.total;
      }
    }

    if (records.length >= MAX_OUTCOME_RECORDS_PER_RUN) break;
    const recoveryOutcome = own(event.payload, "recoveryOutcome");
    if (isJourneyRecoveryOutcome(recoveryOutcome) && code("recovery", recoveryOutcome.outcome)) {
      const signature = `${recoveryOutcome.outcome}\u0000${recoveryOutcome.attempts}`;
      // Value equality alone cannot separate a replayed checkpoint from a second genuine episode
      // with the same outcome and attempt count. The accepted command content hash is a durable,
      // bounded lifecycle discriminator already carried by the envelope: one replayed checkpoint
      // keeps one identity, while two distinct episodes come from two distinct commands. Absent or
      // unreadable identity fails closed to value-only coalescing so nothing is double counted.
      const commandRef = typeof event.commandContentHash === "string"
        && DIGEST.test(event.commandContentHash)
        ? event.commandContentHash
        : undefined;
      const distinctEpisode = commandRef !== undefined
        && previousRecoveryCommandRef !== undefined
        && commandRef !== previousRecoveryCommandRef;
      if (signature !== previousRecoverySignature || distinctEpisode) {
        append({
          schemaVersion: 1,
          runRef,
          recordedAt: event.recordedAt,
          signal: "recovery",
          code: recoveryOutcome.outcome,
          attempts: recoveryOutcome.attempts,
        });
      }
      previousRecoverySignature = signature;
      previousRecoveryCommandRef = commandRef;
    } else {
      previousRecoverySignature = undefined;
      previousRecoveryCommandRef = undefined;
    }

    const status = own(event.payload, "status");
    const planningFailure = own(event.payload, "planningFailure");
    if (status === "failed" && code("validation_failure", planningFailure)) {
      append({
        schemaVersion: 1,
        runRef,
        recordedAt: event.recordedAt,
        signal: "validation_failure",
        code: planningFailure,
      });
    }

    if (records.length >= MAX_OUTCOME_RECORDS_PER_RUN) break;
    const verification = own(event.payload, "verification");
    if (isVerificationCheckpointPayload(verification)
      && verification.layer === "grader"
      && code("grader_score", verification.verdict)) {
      append({
        schemaVersion: 1,
        runRef,
        recordedAt: event.recordedAt,
        signal: "grader_score",
        code: verification.verdict,
      });
    }

    if (records.length >= MAX_OUTCOME_RECORDS_PER_RUN) break;
    if (isVerificationCheckpointPayload(verification)) {
      if (verification.layer === "validator"
        && verification.verdict === "PASS"
        && verification.completedSlices !== undefined) {
        for (const completed of verification.completedSlices) {
          if (completedSliceIds.has(completed.sliceId)) continue;
          const sliceRef = sliceRefFor(completed.sliceId);
          if (sliceRef === undefined) continue;
          if (!append({
            schemaVersion: 1,
            runRef,
            sliceRef,
            recordedAt: event.recordedAt,
            sequence: event.sequence,
            signal: "slice_completion",
            code: "complete",
            requirementRefs: [...completed.requirementIds],
          })) break;
          completedSliceIds.add(completed.sliceId);
        }
      } else if (verification.layer === "park-ranger") {
        for (const rawSliceId of verification.reviewedSliceIds ?? []) {
          if (reviewedSliceIds.has(rawSliceId)) continue;
          const sliceRef = sliceRefFor(rawSliceId);
          if (sliceRef === undefined) continue;
          if (!append({ schemaVersion: 1, runRef, sliceRef, recordedAt: event.recordedAt,
            sequence: event.sequence, signal: "park_ranger_review", code: "complete" })) break;
          reviewedSliceIds.add(rawSliceId);
        }
        if (verification.confirmedFindings === undefined) continue;
        for (const finding of verification.confirmedFindings) {
          for (const rawSliceId of finding.sliceIds) {
            const relation = `${finding.findingRef}\u0000${rawSliceId}`;
            if (findingRelations.has(relation)) continue;
            const sliceRef = sliceRefFor(rawSliceId);
            if (sliceRef === undefined) continue;
            if (!append({
              schemaVersion: 1,
              runRef,
              sliceRef,
              recordedAt: event.recordedAt,
              sequence: event.sequence,
              signal: "park_ranger_finding",
              code: finding.priority,
              findingRef: finding.findingRef,
            })) break;
            findingRelations.add(relation);
          }
          if (records.length >= MAX_OUTCOME_RECORDS_PER_RUN) break;
        }
      }
    }

    if (records.length >= MAX_OUTCOME_RECORDS_PER_RUN) break;
    const runtimeStateJson = own(event.payload, "runtimeStateJson");
    if (typeof runtimeStateJson !== "string") continue;
    const runtimeState = parseRuntimeState(runtimeStateJson);
    if (!runtimeState.ok) continue;

    const currentRetrySignatures = runtimeState.value.retry.map(retrySignature);
    const retryOffset = appendedRetryOffset(
      previousRetrySignatures,
      currentRetrySignatures,
      retryInitialized,
    );
    for (let index = retryOffset; index < runtimeState.value.retry.length; index += 1) {
      const entry = runtimeState.value.retry[index];
      if (entry === undefined || !code("retry", entry.outcome)) continue;
      const fingerprintRef = digest(entry.fingerprint, input.digest);
      if (fingerprintRef === undefined) continue;
      if (!append({
        schemaVersion: 1,
        runRef,
        recordedAt: event.recordedAt,
        signal: "retry",
        code: entry.outcome,
        reasoningTier: entry.reasoningTier,
        fingerprintRef,
      })) break;
    }
    retryInitialized = true;
    previousRetrySignatures = currentRetrySignatures;

    if (records.length >= MAX_OUTCOME_RECORDS_PER_RUN) break;
    const concurrency = Object.hasOwn(runtimeState.value, "concurrency")
      ? runtimeState.value.concurrency
      : undefined;
    const currentConcurrencySignature = concurrencySignature(concurrency);
    const changed = !concurrencyInitialized
      || currentConcurrencySignature !== previousConcurrencySignature;
    concurrencyInitialized = true;
    previousConcurrencySignature = currentConcurrencySignature;
    const reducedBy = concurrency !== undefined && Object.hasOwn(concurrency, "reducedBy")
      ? concurrency.reducedBy
      : undefined;
    if (changed && concurrency !== undefined
      && code("concurrency_conflict", reducedBy)
      && smallCount(concurrency.cap)) {
      append({
        schemaVersion: 1,
        runRef,
        recordedAt: event.recordedAt,
        signal: "concurrency_conflict",
        code: reducedBy,
        value: concurrency.cap,
      });
    }
  }

  return Object.freeze(records);
}
