import { ROLES } from "../profile/profile.js";
import { DEFAULT_REASONING_TIERS, REASONING_TIERS, } from "../profile/reasoning-policy.js";
export const RECOMMENDABLE_SURFACES = Object.freeze([
    "reasoning-default",
    "review-cadence",
    "test-depth",
    "concurrency-cap",
    "planning-template",
    "skill-guidance",
]);
/** The only path into AgentProfile that the recommender may name. */
export const RECOMMENDABLE_PROFILE_TARGETS = Object.freeze([
    "reasoningPolicy.defaults",
]);
export const PATTERN_IDS = Object.freeze([
    "recurring-retry-fingerprint",
    "write-set-overrun",
    "concurrency-conflict-cluster",
    "grader-disagreement",
    "escaped-defect-concentration",
    "ineffective-escalation",
]);
/** OQ-6.1: proposed defaults, frozen and injected rather than hidden at call sites. */
export const DEFAULT_IMPROVEMENT_THRESHOLDS = Object.freeze({
    minSettledRuns: 20,
    minOccurrences: 5,
    minDistinctRuns: 3,
    minDenominator: 20,
    minEffect: 0.15,
    trialMinOccurrences: 5,
    trialMinDistinctRuns: 3,
    trialMaxAgeDays: 90,
});
const DIGEST_REF = /^[a-f0-9]{64}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const REVIEW_CADENCE = Object.freeze(["completion-only", "per-phase", "per-slice"]);
const TEST_DEPTH = Object.freeze(["unit", "integration", "system"]);
const PLANNING_REQUIREMENTS = Object.freeze([
    "write-set-granularity-check",
    "validation-command",
    "requirement-trace",
]);
const METRIC_IDS = Object.freeze([
    "coordination-overhead",
    "first-pass-success",
    "grading-accuracy",
    "escaped-defects",
    "cost-per-accepted-criterion",
]);
const GUARD_IDS = Object.freeze([
    "escaped-defects",
    "first-pass-success",
    "cost-per-accepted-criterion",
]);
const EMPTY_RECOMMENDATIONS = Object.freeze([]);
function object(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function own(value, key) {
    if (!object(value) || !Object.hasOwn(value, key))
        return undefined;
    try {
        return value[key];
    }
    catch {
        return undefined;
    }
}
function exactOwnKeys(value, required) {
    if (!object(value))
        return false;
    const keys = Reflect.ownKeys(value);
    return required.every((key) => Object.hasOwn(value, key))
        && keys.every((key) => typeof key === "string" && required.includes(key));
}
function enumValue(value, values) {
    return typeof value === "string" && values.includes(value);
}
function nonNegativeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function positiveInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function finiteNonNegative(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function deepFreeze(value) {
    if (typeof value !== "object" || value === null || Object.isFrozen(value))
        return value;
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key === "string" && Object.hasOwn(value, key)) {
            deepFreeze(value[key]);
        }
    }
    return Object.freeze(value);
}
function cloneMetric(value) {
    if (!object(value))
        return undefined;
    const allowedKeys = Object.hasOwn(value, "confusion")
        ? ["id", "value", "numerator", "denominator", "sufficient", "confusion"]
        : ["id", "value", "numerator", "denominator", "sufficient"];
    if (!exactOwnKeys(value, allowedKeys))
        return undefined;
    const id = own(value, "id");
    const metricValue = own(value, "value");
    const numerator = own(value, "numerator");
    const denominator = own(value, "denominator");
    const sufficient = own(value, "sufficient");
    if (!enumValue(id, METRIC_IDS)
        || !nonNegativeInteger(numerator)
        || !nonNegativeInteger(denominator)
        || typeof sufficient !== "boolean"
        || (sufficient ? typeof metricValue !== "number" || !Number.isFinite(metricValue) : metricValue !== null)) {
        return undefined;
    }
    if (Object.hasOwn(value, "confusion")) {
        const confusion = own(value, "confusion");
        if (!object(confusion))
            return undefined;
        const cloned = {};
        for (const key of Reflect.ownKeys(confusion)) {
            if (typeof key !== "string" || !Object.hasOwn(confusion, key))
                return undefined;
            const count = own(confusion, key);
            if (!nonNegativeInteger(count))
                return undefined;
            cloned[key] = count;
        }
        return deepFreeze({
            id,
            value: metricValue,
            numerator,
            denominator,
            sufficient,
            confusion: cloned,
        });
    }
    return Object.freeze({
        id,
        value: metricValue,
        numerator,
        denominator,
        sufficient,
    });
}
function metricById(metrics, id) {
    if (Array.isArray(metrics)) {
        for (const value of metrics) {
            const metric = cloneMetric(value);
            if (metric?.id === id)
                return metric;
        }
        return undefined;
    }
    if (!object(metrics))
        return undefined;
    for (const key of Reflect.ownKeys(metrics)) {
        if (typeof key !== "string" || !Object.hasOwn(metrics, key))
            continue;
        const metric = cloneMetric(own(metrics, key));
        if (metric?.id === id)
            return metric;
    }
    return undefined;
}
function guardMetrics(metrics) {
    const result = [];
    for (const id of GUARD_IDS) {
        const metric = metricById(metrics, id);
        if (metric === undefined)
            return undefined;
        result.push(metric);
    }
    return Object.freeze(result);
}
function cloneEvidence(value) {
    if (!exactOwnKeys(value, ["recordRefs", "occurrences", "distinctRuns"]))
        return undefined;
    const recordRefs = own(value, "recordRefs");
    const occurrences = own(value, "occurrences");
    const distinctRuns = own(value, "distinctRuns");
    if (!Array.isArray(recordRefs)
        || recordRefs.length === 0
        || recordRefs.length > 1_000
        || !recordRefs.every((ref) => typeof ref === "string" && DIGEST_REF.test(ref))
        || !positiveInteger(occurrences)
        || !positiveInteger(distinctRuns)
        || distinctRuns > occurrences)
        return undefined;
    return Object.freeze({
        recordRefs: Object.freeze([...recordRefs]),
        occurrences,
        distinctRuns,
    });
}
function cloneTrial(value) {
    if (!exactOwnKeys(value, [
        "minOccurrences",
        "minDistinctRuns",
        "maxAgeDays",
        "openedAtRef",
    ]))
        return undefined;
    const minOccurrences = own(value, "minOccurrences");
    const minDistinctRuns = own(value, "minDistinctRuns");
    const maxAgeDays = own(value, "maxAgeDays");
    const openedAtRef = own(value, "openedAtRef");
    if (!positiveInteger(minOccurrences)
        || !positiveInteger(minDistinctRuns)
        || minDistinctRuns > minOccurrences
        || !positiveInteger(maxAgeDays)
        || typeof openedAtRef !== "string"
        || !DIGEST_REF.test(openedAtRef))
        return undefined;
    return Object.freeze({ minOccurrences, minDistinctRuns, maxAgeDays, openedAtRef });
}
function identifier(value) {
    return typeof value === "string" && SAFE_IDENTIFIER.test(value);
}
function roleTarget(value) {
    if (!exactOwnKeys(value, ["role"]))
        return undefined;
    const role = own(value, "role");
    return typeof role === "string" && Object.hasOwn(DEFAULT_REASONING_TIERS, role)
        ? Object.freeze({ role: role })
        : undefined;
}
function reviewTarget(value) {
    if (!exactOwnKeys(value, ["role"]))
        return undefined;
    const role = own(value, "role");
    const allowed = [...ROLES, "validator", "grader", "park-ranger"];
    return enumValue(role, allowed) ? Object.freeze({ role }) : undefined;
}
function testTarget(value) {
    if (!exactOwnKeys(value, ["layer"]))
        return undefined;
    const layer = own(value, "layer");
    return enumValue(layer, TEST_DEPTH) ? Object.freeze({ layer }) : undefined;
}
function concurrencyTarget(value) {
    return exactOwnKeys(value, ["scope"]) && own(value, "scope") === "workspace"
        ? Object.freeze({ scope: "workspace" })
        : undefined;
}
function planningTarget(value) {
    if (!exactOwnKeys(value, ["sectionId"]))
        return undefined;
    const sectionId = own(value, "sectionId");
    return enumValue(sectionId, ["write-set", "validation", "requirements"])
        ? Object.freeze({ sectionId })
        : undefined;
}
function skillTarget(value) {
    if (!exactOwnKeys(value, ["skillName", "sectionId"]))
        return undefined;
    const skillName = own(value, "skillName");
    const sectionId = own(value, "sectionId");
    return identifier(skillName) && identifier(sectionId)
        ? Object.freeze({ skillName, sectionId })
        : undefined;
}
function pointer(value, target) {
    if (!exactOwnKeys(value, ["kind", "skillName", "sectionId"]))
        return undefined;
    return own(value, "kind") === "pointer"
        && own(value, "skillName") === target.skillName
        && own(value, "sectionId") === target.sectionId
        ? Object.freeze({ kind: "pointer", ...target })
        : undefined;
}
function planningValue(value) {
    if (!Array.isArray(value)
        || value.length > PLANNING_REQUIREMENTS.length
        || !value.every((entry) => enumValue(entry, PLANNING_REQUIREMENTS))
        || new Set(value).size !== value.length)
        return undefined;
    return Object.freeze([...value]);
}
function targetAndDirection(surface, rawTarget, rawFrom, rawTo) {
    if (surface === "reasoning-default") {
        const target = roleTarget(rawTarget);
        if (target === undefined)
            return "target_unknown";
        if (!enumValue(rawFrom, REASONING_TIERS)
            || !enumValue(rawTo, REASONING_TIERS)
            || rawFrom === rawTo)
            return "direction_forbidden";
        return { target, from: rawFrom, to: rawTo };
    }
    if (surface === "review-cadence") {
        const target = reviewTarget(rawTarget);
        if (target === undefined)
            return "target_unknown";
        if (!enumValue(rawFrom, REVIEW_CADENCE)
            || !enumValue(rawTo, REVIEW_CADENCE)
            || REVIEW_CADENCE.indexOf(rawTo) <= REVIEW_CADENCE.indexOf(rawFrom)) {
            return "direction_forbidden";
        }
        return { target, from: rawFrom, to: rawTo };
    }
    if (surface === "test-depth") {
        const target = testTarget(rawTarget);
        if (target === undefined)
            return "target_unknown";
        if (!enumValue(rawFrom, TEST_DEPTH)
            || !enumValue(rawTo, TEST_DEPTH)
            || TEST_DEPTH.indexOf(rawTo) <= TEST_DEPTH.indexOf(rawFrom)) {
            return "direction_forbidden";
        }
        return { target, from: rawFrom, to: rawTo };
    }
    if (surface === "concurrency-cap") {
        const target = concurrencyTarget(rawTarget);
        if (target === undefined)
            return "target_unknown";
        if (!positiveInteger(rawFrom) || !positiveInteger(rawTo) || rawTo >= rawFrom) {
            return "direction_forbidden";
        }
        return { target, from: rawFrom, to: rawTo };
    }
    if (surface === "planning-template") {
        const target = planningTarget(rawTarget);
        if (target === undefined)
            return "target_unknown";
        const from = planningValue(rawFrom);
        const to = planningValue(rawTo);
        if (from === undefined
            || to === undefined
            || to.length <= from.length
            || !from.every((requirement) => to.includes(requirement)))
            return "direction_forbidden";
        return { target, from, to };
    }
    const target = skillTarget(rawTarget);
    if (target === undefined)
        return "target_unknown";
    const to = pointer(rawTo, target);
    if (rawFrom !== null || to === undefined)
        return "direction_forbidden";
    return { target, from: null, to };
}
function cloneGuards(value) {
    if (!Array.isArray(value) || value.length !== GUARD_IDS.length)
        return undefined;
    const cloned = [];
    for (const entry of value) {
        const metric = cloneMetric(entry);
        if (metric === undefined)
            return undefined;
        cloned.push(metric);
    }
    const ids = new Set(cloned.map(({ id }) => id));
    if (ids.size !== GUARD_IDS.length || !GUARD_IDS.every((id) => ids.has(id)))
        return undefined;
    return Object.freeze(cloned);
}
/** Validating factory: an invalid recommendation is never materialized. */
export function buildRecommendation(input) {
    const rawSurface = own(input, "surface");
    if (!enumValue(rawSurface, RECOMMENDABLE_SURFACES)) {
        return Object.freeze({ ok: false, code: "surface_not_recommendable" });
    }
    const patternId = own(input, "patternId");
    if (!enumValue(patternId, PATTERN_IDS)) {
        return Object.freeze({ ok: false, code: "target_unknown" });
    }
    const normalized = targetAndDirection(rawSurface, own(input, "target"), own(input, "from"), own(input, "to"));
    if (typeof normalized === "string")
        return Object.freeze({ ok: false, code: normalized });
    const evidence = cloneEvidence(own(input, "evidence"));
    const baseline = cloneMetric(own(input, "baseline"));
    const guards = cloneGuards(own(input, "guards"));
    const trial = cloneTrial(own(input, "trial"));
    if (evidence === undefined
        || baseline === undefined
        || !baseline.sufficient
        || baseline.value === null
        || guards === undefined
        || guards.some((guard) => !guard.sufficient || guard.value === null)
        || trial === undefined) {
        return Object.freeze({ ok: false, code: "insufficient_evidence" });
    }
    const revert = Object.freeze({
        surface: rawSurface,
        target: normalized.target,
        value: normalized.from,
    });
    return Object.freeze({
        ok: true,
        value: deepFreeze({
            patternId,
            surface: rawSurface,
            target: normalized.target,
            from: normalized.from,
            to: normalized.to,
            evidence,
            baseline,
            guards,
            trial,
            revert,
        }),
    });
}
function validThresholds(value) {
    if (!exactOwnKeys(value, [
        "minSettledRuns",
        "minOccurrences",
        "minDistinctRuns",
        "minDenominator",
        "minEffect",
        "trialMinOccurrences",
        "trialMinDistinctRuns",
        "trialMaxAgeDays",
    ]))
        return false;
    return positiveInteger(own(value, "minSettledRuns"))
        && positiveInteger(own(value, "minOccurrences"))
        && positiveInteger(own(value, "minDistinctRuns"))
        && positiveInteger(own(value, "minDenominator"))
        && finiteNonNegative(own(value, "minEffect"))
        && own(value, "minEffect") <= 1
        && positiveInteger(own(value, "trialMinOccurrences"))
        && positiveInteger(own(value, "trialMinDistinctRuns"))
        && positiveInteger(own(value, "trialMaxAgeDays"));
}
function recordOwn(record, key) {
    return own(record, key);
}
function largestBucket(records, keyOf) {
    const buckets = new Map();
    for (const record of records) {
        const key = keyOf(record);
        if (key === undefined)
            continue;
        const bucket = buckets.get(key);
        if (bucket === undefined)
            buckets.set(key, [record]);
        else
            bucket.push(record);
    }
    let largest;
    for (const bucket of buckets.values()) {
        if (largest === undefined || bucket.length > largest.length)
            largest = bucket;
    }
    if (largest === undefined)
        return undefined;
    const runRefs = new Set();
    for (const record of largest) {
        const runRef = recordOwn(record, "runRef");
        if (typeof runRef === "string" && DIGEST_REF.test(runRef))
            runRefs.add(runRef);
    }
    return { records: largest, runRefs };
}
function evidenceFor(bucket) {
    const recordRefs = [...bucket.runRefs];
    if (recordRefs.length === 0)
        return undefined;
    return Object.freeze({
        recordRefs: Object.freeze(recordRefs),
        occurrences: bucket.records.length,
        distinctRuns: bucket.runRefs.size,
    });
}
function patternReady(evidence, baseline, thresholds) {
    const effect = baseline.denominator === 0 ? 0 : evidence.occurrences / baseline.denominator;
    return evidence.occurrences >= thresholds.minOccurrences
        && evidence.distinctRuns >= thresholds.minDistinctRuns
        && baseline.sufficient
        && baseline.value !== null
        && baseline.denominator >= thresholds.minDenominator
        && effect >= thresholds.minEffect;
}
function detectorInput(context, patternId, surface, target, from, to, evidence, baselineId) {
    const baseline = metricById(context.metrics, baselineId);
    const guards = guardMetrics(context.metrics);
    if (baseline === undefined || guards === undefined
        || !patternReady(evidence, baseline, context.thresholds))
        return undefined;
    const openedAtRef = evidence.recordRefs[0];
    if (openedAtRef === undefined)
        return undefined;
    return {
        patternId,
        surface,
        target,
        from,
        to,
        evidence,
        baseline,
        guards,
        trial: {
            minOccurrences: context.thresholds.trialMinOccurrences,
            minDistinctRuns: context.thresholds.trialMinDistinctRuns,
            maxAgeDays: context.thresholds.trialMaxAgeDays,
            openedAtRef,
        },
    };
}
function construct(input) {
    if (input === undefined)
        return undefined;
    const result = buildRecommendation(input);
    return result.ok ? result.value : undefined;
}
function recurringRetry(context) {
    const bucket = largestBucket(context.window.records, (record) => {
        if (recordOwn(record, "signal") !== "retry")
            return undefined;
        const fingerprintRef = recordOwn(record, "fingerprintRef");
        const role = recordOwn(record, "role");
        const reasoningTier = recordOwn(record, "reasoningTier");
        return typeof fingerprintRef === "string" && DIGEST_REF.test(fingerprintRef)
            && typeof role === "string" && Object.hasOwn(DEFAULT_REASONING_TIERS, role)
            && enumValue(reasoningTier, REASONING_TIERS)
            ? `${fingerprintRef}:${role}:${reasoningTier}`
            : undefined;
    });
    if (bucket === undefined)
        return undefined;
    const evidence = evidenceFor(bucket);
    const first = bucket.records[0];
    if (evidence === undefined || first === undefined)
        return undefined;
    const role = recordOwn(first, "role");
    const reasoningTier = recordOwn(first, "reasoningTier");
    if (typeof role !== "string" || !Object.hasOwn(DEFAULT_REASONING_TIERS, role)
        || !enumValue(reasoningTier, REASONING_TIERS))
        return undefined;
    const tierIndex = REASONING_TIERS.indexOf(reasoningTier);
    const next = REASONING_TIERS[tierIndex + 1];
    if (next === undefined)
        return undefined;
    return construct(detectorInput(context, "recurring-retry-fingerprint", "reasoning-default", { role: role }, reasoningTier, next, evidence, "first-pass-success"));
}
function writeSetOverrun(context) {
    const bucket = largestBucket(context.window.records, (record) => (recordOwn(record, "signal") === "validation_failure"
        && recordOwn(record, "code") === "path_outside_write_set"
        ? "path_outside_write_set"
        : undefined));
    const evidence = bucket === undefined ? undefined : evidenceFor(bucket);
    return evidence === undefined ? undefined : construct(detectorInput(context, "write-set-overrun", "planning-template", { sectionId: "write-set" }, [], ["write-set-granularity-check"], evidence, "first-pass-success"));
}
function concurrencyConflict(context) {
    const bucket = largestBucket(context.window.records, (record) => {
        if (recordOwn(record, "signal") !== "concurrency_conflict")
            return undefined;
        const pathRefs = recordOwn(record, "pathRefs");
        return Array.isArray(pathRefs)
            && pathRefs.length > 0
            && pathRefs.every((ref) => typeof ref === "string" && DIGEST_REF.test(ref))
            ? [...pathRefs].sort().join(":")
            : undefined;
    });
    const evidence = bucket === undefined ? undefined : evidenceFor(bucket);
    const first = bucket?.records[0];
    const cap = first === undefined ? undefined : recordOwn(first, "value");
    if (evidence === undefined || !positiveInteger(cap) || cap <= 1)
        return undefined;
    return construct(detectorInput(context, "concurrency-conflict-cluster", "concurrency-cap", { scope: "workspace" }, cap, cap - 1, evidence, "coordination-overhead"));
}
function graderDisagreement(context) {
    const contradicted = [];
    const findings = new Set();
    for (const record of context.window.records) {
        if (recordOwn(record, "signal") !== "park_ranger_finding")
            continue;
        const sliceRef = recordOwn(record, "sliceRef");
        if (typeof sliceRef === "string" && DIGEST_REF.test(sliceRef))
            findings.add(sliceRef);
    }
    for (const record of context.window.records) {
        if (recordOwn(record, "signal") !== "grader_score")
            continue;
        const code = recordOwn(record, "code");
        const sliceRef = recordOwn(record, "sliceRef");
        if ((code === "strong" || code === "acceptable")
            && typeof sliceRef === "string"
            && findings.has(sliceRef))
            contradicted.push(record);
    }
    const bucket = {
        records: contradicted,
        runRefs: new Set(contradicted.flatMap((record) => {
            const runRef = recordOwn(record, "runRef");
            return typeof runRef === "string" && DIGEST_REF.test(runRef) ? [runRef] : [];
        })),
    };
    const evidence = contradicted.length === 0 ? undefined : evidenceFor(bucket);
    return evidence === undefined ? undefined : construct(detectorInput(context, "grader-disagreement", "review-cadence", { role: "surveyor" }, "per-phase", "per-slice", evidence, "grading-accuracy"));
}
function escapedDefectConcentration(_context) {
    // OutcomeRecord deliberately carries neither source paths nor free-text labels. Until a closed,
    // typed test-layer signal exists, inferring a layer from opaque digests would violate DES-6.1.
    return undefined;
}
function ineffectiveEscalation(context) {
    const bucket = largestBucket(context.window.records, (record) => {
        if (recordOwn(record, "signal") !== "reasoning_effectiveness"
            || recordOwn(record, "code") !== "failed")
            return undefined;
        const role = recordOwn(record, "role");
        const tier = recordOwn(record, "reasoningTier");
        return typeof role === "string" && Object.hasOwn(DEFAULT_REASONING_TIERS, role)
            && enumValue(tier, REASONING_TIERS)
            ? `${role}:${tier}`
            : undefined;
    });
    const evidence = bucket === undefined ? undefined : evidenceFor(bucket);
    const first = bucket?.records[0];
    if (evidence === undefined || first === undefined)
        return undefined;
    const role = recordOwn(first, "role");
    const tier = recordOwn(first, "reasoningTier");
    if (typeof role !== "string" || !Object.hasOwn(DEFAULT_REASONING_TIERS, role)
        || !enumValue(tier, REASONING_TIERS))
        return undefined;
    const prior = REASONING_TIERS[REASONING_TIERS.indexOf(tier) - 1];
    if (prior === undefined)
        return undefined;
    return construct(detectorInput(context, "ineffective-escalation", "reasoning-default", { role: role }, tier, prior, evidence, "first-pass-success"));
}
function namedDetector(id, detect) {
    Object.defineProperty(detect, "id", { value: id, enumerable: true });
    return Object.freeze(detect);
}
/** Closed Strategy catalog. Callers cannot inject additional pattern kinds. */
export const DETECTOR_CATALOG = Object.freeze([
    namedDetector("recurring-retry-fingerprint", recurringRetry),
    namedDetector("write-set-overrun", writeSetOverrun),
    namedDetector("concurrency-conflict-cluster", concurrencyConflict),
    namedDetector("grader-disagreement", graderDisagreement),
    namedDetector("escaped-defect-concentration", escapedDefectConcentration),
    namedDetector("ineffective-escalation", ineffectiveEscalation),
]);
function evidencePosition(context) {
    let occurrences = 0;
    let distinctRuns = 0;
    let denominator = 0;
    for (const detector of DETECTOR_CATALOG) {
        // Detectors remain the sole pattern interpreters; diagnostics use only accepted outputs.
        const recommendation = detector(context);
        if (recommendation === undefined)
            continue;
        occurrences = Math.max(occurrences, recommendation.evidence.occurrences);
        distinctRuns = Math.max(distinctRuns, recommendation.evidence.distinctRuns);
        denominator = Math.max(denominator, recommendation.baseline.denominator);
    }
    return { settledRuns: context.window.settledRuns, occurrences, distinctRuns, denominator };
}
/** Pure observe-independent detect/recommend stage over injected records, metrics, and thresholds. */
export function recommend(input) {
    const thresholds = input.thresholds ?? DEFAULT_IMPROVEMENT_THRESHOLDS;
    const settledRuns = own(input.window, "settledRuns");
    if (!validThresholds(thresholds)
        || !nonNegativeInteger(settledRuns)
        || settledRuns < thresholds.minSettledRuns) {
        return deepFreeze({
            status: "insufficient_evidence",
            have: { settledRuns: nonNegativeInteger(settledRuns) ? settledRuns : 0 },
            need: { minSettledRuns: validThresholds(thresholds) ? thresholds.minSettledRuns : DEFAULT_IMPROVEMENT_THRESHOLDS.minSettledRuns },
            recommendations: EMPTY_RECOMMENDATIONS,
        });
    }
    // This access is intentionally after the cold-start gate.
    const records = own(input.window, "records");
    if (!Array.isArray(records)) {
        return deepFreeze({
            status: "insufficient_evidence",
            have: { settledRuns },
            need: {
                minSettledRuns: thresholds.minSettledRuns,
                minOccurrences: thresholds.minOccurrences,
                minDistinctRuns: thresholds.minDistinctRuns,
                minDenominator: thresholds.minDenominator,
                minEffect: thresholds.minEffect,
            },
            recommendations: EMPTY_RECOMMENDATIONS,
        });
    }
    const context = { window: { settledRuns, records }, metrics: input.metrics, thresholds };
    const recommendations = [];
    try {
        for (const detector of DETECTOR_CATALOG) {
            const recommendation = detector(context);
            if (recommendation !== undefined)
                recommendations.push(recommendation);
        }
    }
    catch {
        return deepFreeze({
            status: "insufficient_evidence",
            have: { settledRuns },
            need: { minSettledRuns: thresholds.minSettledRuns },
            recommendations: EMPTY_RECOMMENDATIONS,
        });
    }
    if (recommendations.length === 0) {
        return deepFreeze({
            status: "insufficient_evidence",
            have: evidencePosition(context),
            need: {
                minSettledRuns: thresholds.minSettledRuns,
                minOccurrences: thresholds.minOccurrences,
                minDistinctRuns: thresholds.minDistinctRuns,
                minDenominator: thresholds.minDenominator,
                minEffect: thresholds.minEffect,
            },
            recommendations: EMPTY_RECOMMENDATIONS,
        });
    }
    return deepFreeze({
        status: "ready",
        thresholds,
        recommendations,
    });
}
