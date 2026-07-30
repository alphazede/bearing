import { REASONING_TIERS } from "../profile/reasoning-policy.js";
export const MAX_RUNTIME_STATE_JSON = 640 * 1024;
export const MAX_RUNTIME_STATE_STRING = 4096;
export const MAX_RUNTIME_STATE_ARRAY = 64;
const MAX_ACTIVITY_TRAIL = 20;
const MAX_RUBRIC_VERSION = 64;
const SAFE_ACTIVITY_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SECRET_ACTIVITY = /(?:\b(?:api[_ -]?key|secret|token|password|authorization)\s*[=:]\s*|\bBearer\s+|\bsk-[A-Za-z0-9_-]{8,}|\bAKIA[A-Z0-9]{16})[^\s,;]*/i;
export const RETRY_WARRANTS = [
    "new_hypothesis",
    "new_evidence",
    "changed_strategy",
    "changed_environment",
    "approved_amendment",
];
export const RETRY_OUTCOMES = [
    "admitted",
    "retry_requires_warrant",
    "same_attempt_higher_reasoning",
    "retry_limit_reached",
    "escalation_required",
];
export const CONCURRENCY_SIGNALS = [
    "write_set_conflict",
    "shared_file",
    "unstable_test",
    "repeated_integration_failure",
];
const RECORD_KEYS = ["version", "trace", "retry", "concurrency", "grading", "sessionContinuity"];
const ACTIVITY_KEYS = ["sequence", "recordedAt", "kind", "status", "tool"];
const RETRY_KEYS = ["fingerprint", "warrant", "reasoningTier", "outcome"];
const CONCURRENCY_KEYS = ["admittedLanes", "cap", "controller", "reducedBy"];
const GRADING_KEYS = ["verdict", "rubricVersion", "findingCount"];
function object(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasUnknownKey(value, keys) {
    return Object.keys(value).some((key) => !keys.includes(key));
}
function hasOwnKeys(value, keys) {
    return keys.every((key) => Object.hasOwn(value, key));
}
function boundedString(value, max = MAX_RUNTIME_STATE_STRING) {
    if (typeof value !== "string" || value.length === 0)
        return "malformed";
    return value.length > max ? "string_too_long" : undefined;
}
function positiveInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function nonNegativeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function enumValue(value, values) {
    return typeof value === "string" && values.includes(value);
}
function validateActivity(value) {
    if (!object(value))
        return "malformed";
    if (hasUnknownKey(value, ACTIVITY_KEYS))
        return "unknown_key";
    if (!hasOwnKeys(value, ["sequence", "recordedAt", "kind"]))
        return "malformed";
    if (!positiveInteger(value.sequence))
        return "malformed";
    for (const key of ["recordedAt", "kind", "status", "tool"]) {
        if (!Object.hasOwn(value, key))
            continue;
        const activityValue = value[key];
        if (typeof activityValue !== "string")
            return "malformed";
        if (!SAFE_ACTIVITY_VALUE.test(activityValue) || SECRET_ACTIVITY.test(activityValue))
            return "unsafe_trace";
    }
    return undefined;
}
function validateRetry(value) {
    if (!object(value))
        return "malformed";
    if (hasUnknownKey(value, RETRY_KEYS))
        return "unknown_key";
    if (!hasOwnKeys(value, ["fingerprint", "warrant", "reasoningTier", "outcome"]))
        return "malformed";
    const fingerprintFailure = boundedString(value.fingerprint);
    if (fingerprintFailure)
        return fingerprintFailure;
    if (!/^[a-f0-9]{64}$/.test(value.fingerprint))
        return "malformed";
    if (!enumValue(value.reasoningTier, REASONING_TIERS))
        return "malformed";
    const outcomeFailure = boundedString(value.outcome);
    if (outcomeFailure)
        return outcomeFailure;
    if (!enumValue(value.outcome, RETRY_OUTCOMES))
        return "malformed";
    if (value.warrant !== null && !enumValue(value.warrant, RETRY_WARRANTS))
        return "malformed";
    return undefined;
}
function validateConcurrency(value) {
    if (!object(value))
        return "malformed";
    if (hasUnknownKey(value, CONCURRENCY_KEYS))
        return "unknown_key";
    if (!hasOwnKeys(value, ["admittedLanes", "cap", "controller"]))
        return "malformed";
    if (!Array.isArray(value.admittedLanes))
        return "malformed";
    if (value.admittedLanes.length > MAX_RUNTIME_STATE_ARRAY)
        return "array_too_long";
    for (const lane of value.admittedLanes) {
        const laneFailure = boundedString(lane);
        if (laneFailure)
            return laneFailure;
    }
    if (!nonNegativeInteger(value.cap) || value.cap > MAX_RUNTIME_STATE_ARRAY)
        return "malformed";
    if (value.controller !== "trail-boss" && value.controller !== "explorer")
        return "malformed";
    if (Object.hasOwn(value, "reducedBy") && !enumValue(value.reducedBy, CONCURRENCY_SIGNALS))
        return "malformed";
    return undefined;
}
function validateGrading(value) {
    if (!object(value))
        return "malformed";
    if (hasUnknownKey(value, GRADING_KEYS))
        return "unknown_key";
    if (!hasOwnKeys(value, ["verdict"]))
        return "malformed";
    if (value.verdict !== "strong" && value.verdict !== "acceptable" && value.verdict !== "weak")
        return "malformed";
    if (Object.hasOwn(value, "rubricVersion")) {
        const rubricFailure = boundedString(value.rubricVersion, MAX_RUBRIC_VERSION);
        if (rubricFailure)
            return rubricFailure;
    }
    if (Object.hasOwn(value, "findingCount") && !nonNegativeInteger(value.findingCount))
        return "malformed";
    return undefined;
}
function validateRecord(value) {
    if (!object(value))
        return "malformed";
    if (hasUnknownKey(value, RECORD_KEYS))
        return "unknown_key";
    if (!hasOwnKeys(value, ["version", "trace", "retry"]))
        return "malformed";
    if (value.version !== 1)
        return "unsupported_version";
    if (!Array.isArray(value.trace) || !Array.isArray(value.retry))
        return "malformed";
    if (value.trace.length > MAX_ACTIVITY_TRAIL || value.retry.length > MAX_RUNTIME_STATE_ARRAY)
        return "array_too_long";
    for (const activity of value.trace) {
        const failure = validateActivity(activity);
        if (failure)
            return failure;
    }
    for (const retry of value.retry) {
        const failure = validateRetry(retry);
        if (failure)
            return failure;
    }
    if (Object.hasOwn(value, "concurrency")) {
        const failure = validateConcurrency(value.concurrency);
        if (failure)
            return failure;
    }
    if (Object.hasOwn(value, "grading")) {
        const failure = validateGrading(value.grading);
        if (failure)
            return failure;
    }
    if (Object.hasOwn(value, "sessionContinuity") && value.sessionContinuity !== "intact" && value.sessionContinuity !== "lost")
        return "malformed";
    return undefined;
}
export function parseRuntimeState(json) {
    if (json.length > MAX_RUNTIME_STATE_JSON)
        return { ok: false, reason: "payload_too_large" };
    let value;
    try {
        value = JSON.parse(json);
    }
    catch {
        return { ok: false, reason: "malformed_json" };
    }
    const failure = validateRecord(value);
    return failure
        ? { ok: false, reason: failure }
        : { ok: true, value: value };
}
export function serializeRuntimeState(value) {
    return JSON.stringify(value);
}
