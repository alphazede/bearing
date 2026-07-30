import type { ProjectOutcomesInput, OutcomeRecord } from "./outcome-projection.js";
import {
  BearingStoreError,
  type StoredRunListEntry,
  type StoredRunState,
} from "../store/bearing-store.js";

export interface ImprovementStore {
  readonly list: (limit?: number) => Promise<readonly StoredRunListEntry[]>;
  readonly load: (runId: string) => Promise<StoredRunState>;
}

export interface ImprovementWindow {
  readonly generatedAt: string;
  readonly settledRuns: number;
  readonly records: readonly OutcomeRecord[];
}

export interface ImprovementStages<Thresholds, Metrics, RecommendationResult> {
  readonly project: (input: ProjectOutcomesInput) => readonly OutcomeRecord[];
  readonly measure: (window: ImprovementWindow) => Metrics;
  readonly recommend: (input: {
    readonly window: ImprovementWindow;
    readonly metrics: Metrics;
    readonly thresholds: Thresholds;
  }) => RecommendationResult;
}

export interface ImprovementServiceOptions<Thresholds, Metrics, RecommendationResult> {
  readonly store: ImprovementStore;
  readonly clock: () => string;
  readonly digest: ProjectOutcomesInput["digest"];
  readonly thresholds: Thresholds;
  readonly stages: ImprovementStages<Thresholds, Metrics, RecommendationResult>;
  readonly maxRuns?: number;
  readonly maxRecords?: number;
}

export interface ImprovementReport<Thresholds, Metrics, RecommendationResult> {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly listedRuns: number;
  readonly readableRuns: number;
  readonly settledRuns: number;
  readonly unreadableRuns: number;
  readonly recordsHeld: number;
  readonly recordsTruncated: boolean;
  readonly records: readonly OutcomeRecord[];
  readonly thresholds: Thresholds;
  readonly metrics: Metrics;
  readonly recommendation: RecommendationResult;
}

export type ImprovementServiceFailure =
  | "configuration_invalid"
  | "clock_invalid"
  | "store_read_failed"
  | "stage_failed";

export type ImprovementServiceResult<Thresholds, Metrics, RecommendationResult> =
  | {
      readonly ok: true;
      readonly value: ImprovementReport<Thresholds, Metrics, RecommendationResult>;
    }
  | { readonly ok: false; readonly reason: ImprovementServiceFailure };

const DEFAULT_MAX_RUNS = 20;
const DEFAULT_MAX_RECORDS = 20_000;
const HARD_MAX_RUNS = 50;
const HARD_MAX_RECORDS = 50_000;

function validBound(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function validTimestamp(value: string): boolean {
  if (value.length === 0) return false;
  const milliseconds = Date.parse(value);
  const normalized = value.includes(".") ? value : value.replace("Z", ".000Z");
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === normalized;
}

function unreadable(entry: StoredRunListEntry): boolean {
  return Object.hasOwn(entry, "unreadable")
    && (entry as { readonly unreadable?: unknown }).unreadable === true;
}

function settled(state: StoredRunState): boolean {
  const checkpoint = state.journeyCheckpoint;
  return state.pendingDecision === null
    && checkpoint !== null
    && checkpoint.stage === "review"
    && checkpoint.status === "complete";
}

/** Read-only composition edge over already-persisted Bearing run ledgers. */
export class ImprovementService<Thresholds, Metrics, RecommendationResult> {
  readonly #options: ImprovementServiceOptions<Thresholds, Metrics, RecommendationResult>;
  readonly #maxRuns: number;
  readonly #maxRecords: number;

  constructor(options: ImprovementServiceOptions<Thresholds, Metrics, RecommendationResult>) {
    this.#options = options;
    this.#maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
    this.#maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  }

  async report(): Promise<ImprovementServiceResult<Thresholds, Metrics, RecommendationResult>> {
    if (!validBound(this.#maxRuns, HARD_MAX_RUNS)
      || !validBound(this.#maxRecords, HARD_MAX_RECORDS)) {
      return { ok: false, reason: "configuration_invalid" };
    }

    let generatedAt: string;
    try {
      generatedAt = this.#options.clock();
    } catch {
      return { ok: false, reason: "clock_invalid" };
    }
    if (!validTimestamp(generatedAt)) return { ok: false, reason: "clock_invalid" };

    let listed: readonly StoredRunListEntry[];
    try {
      listed = (await this.#options.store.list(this.#maxRuns)).slice(0, this.#maxRuns);
    } catch {
      return { ok: false, reason: "store_read_failed" };
    }

    let readableRuns = 0;
    let settledRuns = 0;
    let unreadableRuns = 0;
    let recordsTruncated = false;
    const records: OutcomeRecord[] = [];

    for (const entry of listed) {
      if (unreadable(entry)) {
        unreadableRuns += 1;
        continue;
      }

      let state: StoredRunState;
      try {
        state = await this.#options.store.load(entry.runId);
      } catch (error) {
        if (error instanceof BearingStoreError) {
          unreadableRuns += 1;
          continue;
        }
        return { ok: false, reason: "store_read_failed" };
      }
      readableRuns += 1;
      if (!settled(state)) continue;
      settledRuns += 1;

      let projected: readonly OutcomeRecord[];
      try {
        projected = this.#options.stages.project({
          runId: entry.runId,
          events: state.events,
          digest: this.#options.digest,
        });
      } catch {
        return { ok: false, reason: "stage_failed" };
      }
      const remaining = this.#maxRecords - records.length;
      if (projected.length > remaining) recordsTruncated = true;
      const retained = Math.min(projected.length, remaining);
      for (let index = 0; index < retained; index += 1) {
        const record = projected[index];
        if (record !== undefined) records.push(record);
      }
    }

    const frozenRecords = Object.freeze([...records]);
    const window: ImprovementWindow = Object.freeze({
      generatedAt,
      settledRuns,
      records: frozenRecords,
    });

    let metrics: Metrics;
    let recommendation: RecommendationResult;
    try {
      metrics = this.#options.stages.measure(window);
      recommendation = this.#options.stages.recommend({
        window,
        metrics,
        thresholds: this.#options.thresholds,
      });
    } catch {
      return { ok: false, reason: "stage_failed" };
    }

    return {
      ok: true,
      value: Object.freeze({
        schemaVersion: 1,
        generatedAt,
        listedRuns: listed.length,
        readableRuns,
        settledRuns,
        unreadableRuns,
        recordsHeld: frozenRecords.length,
        recordsTruncated,
        records: frozenRecords,
        thresholds: this.#options.thresholds,
        metrics,
        recommendation,
      }),
    };
  }
}
