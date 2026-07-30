import { CONCURRENCY_SIGNALS, RETRY_OUTCOMES, parseRuntimeState, } from "../contracts/runtime-state.js";
import { EXECUTION_MODES } from "../execution/execution-mode.js";
export const MAX_OUTCOME_RECORDS_PER_RUN = 1_000;
export const MAX_OUTCOME_PATH_REFS = 16;
export const OUTCOME_SIGNALS = Object.freeze([
    "validation_failure",
    "retry",
    "grader_score",
    "park_ranger_finding",
    "surveyor_failure",
    "reasoning_effectiveness",
    "concurrency_conflict",
    "coordination",
]);
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
    ]),
    retry: Object.freeze([...RETRY_OUTCOMES]),
    grader_score: Object.freeze(["strong", "acceptable", "weak"]),
    park_ranger_finding: Object.freeze(["P0", "P1", "P2", "P3"]),
    surveyor_failure: Object.freeze(["failed", "blocked", "deviated"]),
    reasoning_effectiveness: Object.freeze(["complete", "failed"]),
    concurrency_conflict: Object.freeze([...CONCURRENCY_SIGNALS]),
    coordination: Object.freeze([...EXECUTION_MODES]),
});
const DIGEST = /^[a-f0-9]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_SMALL_COUNT = 1_000_000;
const EMPTY_OUTCOMES = Object.freeze([]);
function object(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function own(value, key) {
    return Object.hasOwn(value, key) ? value[key] : undefined;
}
function code(signal, value) {
    return typeof value === "string"
        && OUTCOME_CODES[signal].some((allowed) => allowed === value);
}
function recordedAt(value) {
    if (typeof value !== "string" || !ISO_TIMESTAMP.test(value))
        return false;
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z"));
}
function smallCount(value) {
    return typeof value === "number"
        && Number.isSafeInteger(value)
        && value >= 0
        && value <= MAX_SMALL_COUNT;
}
function digest(value, digester) {
    try {
        const reference = digester(value);
        return DIGEST.test(reference) ? reference : undefined;
    }
    catch {
        return undefined;
    }
}
function freezeRecord(draft) {
    const pathRefs = Object.hasOwn(draft, "pathRefs") ? draft.pathRefs : undefined;
    const record = pathRefs === undefined
        ? { ...draft }
        : { ...draft, pathRefs: Object.freeze([...pathRefs].slice(0, MAX_OUTCOME_PATH_REFS)) };
    return Object.freeze(record);
}
function retrySignature(entry) {
    return `${entry.fingerprint}\u0000${entry.warrant ?? ""}\u0000${entry.reasoningTier}\u0000${entry.outcome}`;
}
/**
 * Runtime retry state is cumulative. Find the largest previous-suffix/current-prefix overlap so a
 * checkpoint replay does not turn one retry into many outcome records. The same rule also handles
 * the bounded runtime ledger dropping old entries from its front.
 */
function appendedRetryOffset(previous, current, initialized) {
    if (!initialized)
        return 0;
    for (let size = Math.min(previous.length, current.length); size > 0; size -= 1) {
        const previousStart = previous.length - size;
        if (current.slice(0, size).every((value, index) => value === previous[previousStart + index])) {
            return size;
        }
    }
    return 0;
}
function concurrencySignature(value) {
    if (value === undefined)
        return "";
    return JSON.stringify([
        value.cap,
        value.controller,
        Object.hasOwn(value, "reducedBy") ? value.reducedBy : null,
        value.admittedLanes,
    ]);
}
/** Pure, bounded projection over already-validated local ledger envelopes. */
export function projectOutcomes(input) {
    const runRef = digest(input.runId, input.digest);
    if (runRef === undefined)
        return EMPTY_OUTCOMES;
    const records = [];
    let retryInitialized = false;
    let previousRetrySignatures = [];
    let concurrencyInitialized = false;
    let previousConcurrencySignature = "";
    const append = (draft) => {
        if (records.length >= MAX_OUTCOME_RECORDS_PER_RUN)
            return false;
        records.push(freezeRecord(draft));
        return records.length < MAX_OUTCOME_RECORDS_PER_RUN;
    };
    for (const event of input.events) {
        if (records.length >= MAX_OUTCOME_RECORDS_PER_RUN)
            break;
        if (!recordedAt(event.recordedAt) || !object(event.payload))
            continue;
        if (event.type === "executionModeRecommended") {
            const recommendedMode = own(event.payload, "recommendedMode");
            const estimatedAgents = own(event.payload, "estimatedAgents");
            if (code("coordination", recommendedMode) && smallCount(estimatedAgents)) {
                append({
                    schemaVersion: 1,
                    runRef,
                    recordedAt: event.recordedAt,
                    signal: "coordination",
                    code: recommendedMode,
                    value: estimatedAgents,
                });
            }
            continue;
        }
        if (event.type !== "journeyCheckpointRecorded")
            continue;
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
        if (records.length >= MAX_OUTCOME_RECORDS_PER_RUN)
            break;
        const verification = own(event.payload, "verification");
        if (verification?.layer === "grader" && code("grader_score", verification.verdict)) {
            append({
                schemaVersion: 1,
                runRef,
                recordedAt: event.recordedAt,
                signal: "grader_score",
                code: verification.verdict,
            });
        }
        if (records.length >= MAX_OUTCOME_RECORDS_PER_RUN)
            break;
        const runtimeStateJson = own(event.payload, "runtimeStateJson");
        if (typeof runtimeStateJson !== "string")
            continue;
        const runtimeState = parseRuntimeState(runtimeStateJson);
        if (!runtimeState.ok)
            continue;
        const currentRetrySignatures = runtimeState.value.retry.map(retrySignature);
        const retryOffset = appendedRetryOffset(previousRetrySignatures, currentRetrySignatures, retryInitialized);
        for (let index = retryOffset; index < runtimeState.value.retry.length; index += 1) {
            const entry = runtimeState.value.retry[index];
            if (entry === undefined || !code("retry", entry.outcome))
                continue;
            const fingerprintRef = digest(entry.fingerprint, input.digest);
            if (fingerprintRef === undefined)
                continue;
            if (!append({
                schemaVersion: 1,
                runRef,
                recordedAt: event.recordedAt,
                signal: "retry",
                code: entry.outcome,
                reasoningTier: entry.reasoningTier,
                fingerprintRef,
            }))
                break;
        }
        retryInitialized = true;
        previousRetrySignatures = currentRetrySignatures;
        if (records.length >= MAX_OUTCOME_RECORDS_PER_RUN)
            break;
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
