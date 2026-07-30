import { BearingStoreError, } from "../store/bearing-store.js";
const DEFAULT_MAX_RUNS = 20;
const DEFAULT_MAX_RECORDS = 20_000;
const HARD_MAX_RUNS = 50;
const HARD_MAX_RECORDS = 50_000;
function validBound(value, maximum) {
    return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}
function validTimestamp(value) {
    if (value.length === 0)
        return false;
    const milliseconds = Date.parse(value);
    const normalized = value.includes(".") ? value : value.replace("Z", ".000Z");
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === normalized;
}
function unreadable(entry) {
    return Object.hasOwn(entry, "unreadable")
        && entry.unreadable === true;
}
function settled(state) {
    const checkpoint = state.journeyCheckpoint;
    return state.pendingDecision === null
        && checkpoint !== null
        && checkpoint.stage === "review"
        && checkpoint.status === "complete";
}
/** Read-only composition edge over already-persisted Bearing run ledgers. */
export class ImprovementService {
    #options;
    #maxRuns;
    #maxRecords;
    constructor(options) {
        this.#options = options;
        this.#maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
        this.#maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    }
    async report() {
        if (!validBound(this.#maxRuns, HARD_MAX_RUNS)
            || !validBound(this.#maxRecords, HARD_MAX_RECORDS)) {
            return { ok: false, reason: "configuration_invalid" };
        }
        let generatedAt;
        try {
            generatedAt = this.#options.clock();
        }
        catch {
            return { ok: false, reason: "clock_invalid" };
        }
        if (!validTimestamp(generatedAt))
            return { ok: false, reason: "clock_invalid" };
        let listed;
        try {
            listed = (await this.#options.store.list(this.#maxRuns)).slice(0, this.#maxRuns);
        }
        catch {
            return { ok: false, reason: "store_read_failed" };
        }
        let readableRuns = 0;
        let settledRuns = 0;
        let unreadableRuns = 0;
        let recordsTruncated = false;
        const records = [];
        for (const entry of listed) {
            if (unreadable(entry)) {
                unreadableRuns += 1;
                continue;
            }
            let state;
            try {
                state = await this.#options.store.load(entry.runId);
            }
            catch (error) {
                if (error instanceof BearingStoreError) {
                    unreadableRuns += 1;
                    continue;
                }
                return { ok: false, reason: "store_read_failed" };
            }
            readableRuns += 1;
            if (!settled(state))
                continue;
            settledRuns += 1;
            let projected;
            try {
                projected = this.#options.stages.project({
                    runId: entry.runId,
                    events: state.events,
                    digest: this.#options.digest,
                });
            }
            catch {
                return { ok: false, reason: "stage_failed" };
            }
            const remaining = this.#maxRecords - records.length;
            if (projected.length > remaining)
                recordsTruncated = true;
            const retained = Math.min(projected.length, remaining);
            for (let index = 0; index < retained; index += 1) {
                const record = projected[index];
                if (record !== undefined)
                    records.push(record);
            }
        }
        const frozenRecords = Object.freeze([...records]);
        const window = Object.freeze({
            generatedAt,
            settledRuns,
            records: frozenRecords,
        });
        let metrics;
        let recommendation;
        try {
            metrics = this.#options.stages.measure(window);
            recommendation = this.#options.stages.recommend({
                window,
                metrics,
                thresholds: this.#options.thresholds,
            });
        }
        catch {
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
