import { canonicalStringify, hashEvent } from "../contracts/run.js";
const METRIC_IDS = new Set([
    "coordination-overhead",
    "first-pass-success",
    "grading-accuracy",
    "escaped-defects",
    "cost-per-accepted-criterion",
]);
const GUARD_METRIC_IDS = Object.freeze([
    "escaped-defects",
    "first-pass-success",
    "cost-per-accepted-criterion",
]);
const HIGHER_IS_BETTER = new Set([
    "first-pass-success",
    "grading-accuracy",
]);
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasRequiredAndOptionalKeys(value, required, optional = []) {
    if (!isRecord(value))
        return false;
    const allowed = new Set([...required, ...optional]);
    return required.every((key) => Object.hasOwn(value, key))
        && Object.keys(value).every((key) => allowed.has(key));
}
function isNonNegativeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
}
function isPositiveInteger(value) {
    return Number.isSafeInteger(value) && value > 0;
}
function isNonNegativeFinite(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function isCanonicalValue(value, seen = new Set()) {
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return true;
    if (typeof value === "number")
        return Number.isFinite(value);
    if (typeof value !== "object")
        return false;
    if (seen.has(value))
        return false;
    seen.add(value);
    const valid = Array.isArray(value)
        ? value.every((entry) => isCanonicalValue(entry, seen))
        : Object.keys(value).every((key) => (Object.hasOwn(value, key) && isCanonicalValue(value[key], seen)));
    seen.delete(value);
    return valid;
}
function isMetricSnapshot(value) {
    if (!hasRequiredAndOptionalKeys(value, ["id", "value", "numerator", "denominator", "sufficient"], ["confusion"]))
        return false;
    if (typeof value.id !== "string" || !METRIC_IDS.has(value.id))
        return false;
    if (!isNonNegativeInteger(value.numerator) || !isNonNegativeInteger(value.denominator))
        return false;
    if (typeof value.sufficient !== "boolean")
        return false;
    if (value.sufficient
        ? typeof value.value !== "number" || !Number.isFinite(value.value)
        : value.value !== null)
        return false;
    return !Object.hasOwn(value, "confusion") || isCanonicalValue(value.confusion);
}
function isTrialWindow(value) {
    return hasRequiredAndOptionalKeys(value, ["minOccurrences", "minDistinctRuns", "maxAgeDays", "openedAtRef"])
        && isPositiveInteger(value.minOccurrences)
        && isPositiveInteger(value.minDistinctRuns)
        && isPositiveInteger(value.maxAgeDays)
        && typeof value.openedAtRef === "string"
        && value.openedAtRef.length > 0;
}
function isRevertDescriptor(value) {
    return hasRequiredAndOptionalKeys(value, ["surface", "target", "value"])
        && typeof value.surface === "string"
        && value.surface.length > 0
        && isCanonicalValue(value.target)
        && isCanonicalValue(value.value);
}
function isEvidence(value) {
    return hasRequiredAndOptionalKeys(value, ["recordRefs", "occurrences", "distinctRuns"])
        && Array.isArray(value.recordRefs)
        && value.recordRefs.every((recordRef) => typeof recordRef === "string" && recordRef.length > 0)
        && isNonNegativeInteger(value.occurrences)
        && isNonNegativeInteger(value.distinctRuns);
}
function guardSetValid(values) {
    if (values.length !== GUARD_METRIC_IDS.length)
        return false;
    const ids = new Set(values.map(({ id }) => id));
    return ids.size === GUARD_METRIC_IDS.length
        && GUARD_METRIC_IDS.every((id) => ids.has(id));
}
function isProposalRecommendation(value) {
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
function deepFreeze(value) {
    if (typeof value !== "object" || value === null || Object.isFrozen(value))
        return value;
    for (const key of Object.keys(value)) {
        if (Object.hasOwn(value, key))
            deepFreeze(value[key]);
    }
    return Object.freeze(value);
}
function canonicalClone(value) {
    return JSON.parse(canonicalStringify(value));
}
function sameCanonicalValue(left, right) {
    return canonicalStringify(left) === canonicalStringify(right);
}
function proposalBody(recommendation) {
    return { schemaVersion: 1, recommendation };
}
function hashProposal(recommendation) {
    const canonicalBody = canonicalClone(proposalBody(recommendation));
    // The hash identifies the proposed change, not the opaque evidence pointers:
    // recordRefs (and the openedAtRef derived from the first of them) are digest
    // output that changes with the workspace keying (issue #14), so identical
    // evidence would otherwise hash differently after a keying upgrade and orphan
    // owner applications recorded under the previous keying.
    const evidence = canonicalBody.recommendation.evidence;
    delete evidence.recordRefs;
    const trial = canonicalBody.recommendation.trial;
    delete trial.openedAtRef;
    return hashEvent(canonicalBody);
}
function recommendationRevertMatches(recommendation) {
    return recommendation.revert.surface === recommendation.surface
        && sameCanonicalValue(recommendation.revert.target, recommendation.target)
        && sameCanonicalValue(recommendation.revert.value, recommendation.from);
}
export function buildProposal(recommendation) {
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
    }
    catch {
        return { ok: false, reason: "proposal_malformed" };
    }
}
function recommendationMetric(metric) {
    return {
        id: metric.id,
        value: metric.value,
        numerator: metric.numerator,
        denominator: metric.denominator,
        sufficient: metric.sufficient,
        ...(metric.confusion === undefined ? {} : { confusion: metric.confusion }),
    };
}
/** Adapt the closed recommender contract into the canonical proposal contract. */
export function buildRecommendationProposal(recommendation) {
    const canonical = (value) => value;
    return buildProposal({
        patternId: recommendation.patternId,
        surface: recommendation.surface,
        target: canonical(recommendation.target),
        from: canonical(recommendation.from),
        to: canonical(recommendation.to),
        evidence: recommendation.evidence,
        baseline: recommendationMetric(recommendation.baseline),
        guards: recommendation.guards.map(recommendationMetric),
        trial: recommendation.trial,
        revert: {
            surface: recommendation.revert.surface,
            target: canonical(recommendation.revert.target),
            value: canonical(recommendation.revert.value),
        },
    });
}
function validProposal(value) {
    return hasRequiredAndOptionalKeys(value, ["schemaVersion", "recommendation", "proposalHash"])
        && value.schemaVersion === 1
        && isProposalRecommendation(value.recommendation)
        && guardSetValid(value.recommendation.guards)
        && recommendationRevertMatches(value.recommendation)
        && typeof value.proposalHash === "string"
        && /^[a-f0-9]{64}$/.test(value.proposalHash);
}
function metricById(values, id) {
    return values.find((value) => value.id === id);
}
function improvement(baseline, current) {
    if (!baseline.sufficient || !current.sufficient || baseline.value === null || current.value === null) {
        return null;
    }
    return HIGHER_IS_BETTER.has(baseline.id)
        ? current.value - baseline.value
        : baseline.value - current.value;
}
function verdict(input, status, reason, targetImprovement, guardRegressions) {
    return {
        ok: true,
        value: deepFreeze({
            status,
            prescribedAction: status === "retain" ? "retain" : "revert",
            reason,
            proposalHash: input.proposal.proposalHash,
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
export function evaluateTrial(input) {
    try {
        if (!validProposal(input.proposal))
            return { ok: false, reason: "proposal_malformed" };
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
            if (input.ageDays < trial.maxAgeDays)
                return { ok: false, reason: "window_open" };
            return verdict(input, "inconclusive", "evidence_threshold_not_met", null, []);
        }
        const guardRegressions = [];
        let guardInsufficient = false;
        for (const id of GUARD_METRIC_IDS) {
            const baseline = metricById(input.proposal.recommendation.guards, id);
            const current = metricById(input.currentGuards, id);
            if (!baseline || !current)
                return { ok: false, reason: "guard_set_invalid" };
            const guardImprovement = improvement(baseline, current);
            if (guardImprovement === null) {
                guardInsufficient = true;
            }
            else if (-guardImprovement > input.noiseFloor) {
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
    }
    catch {
        return { ok: false, reason: "trial_malformed" };
    }
}
export function evaluateBoundedTrial(input) {
    try {
        if (!validProposal(input.proposal)) {
            return { ok: false, reason: "proposal_malformed" };
        }
        if (hashProposal(input.proposal.recommendation) !== input.proposal.proposalHash) {
            return { ok: false, reason: "proposal_hash_mismatch" };
        }
        if (input.ownerEvidence.proposalHash !== input.proposal.proposalHash) {
            return { ok: false, reason: "proposal_hash_mismatch" };
        }
        if (!Array.isArray(input.applications)) {
            return { ok: false, reason: "trial_malformed" };
        }
        const matchingApplication = input.applications.find((app) => app != null
            && app.schemaVersion === 1
            && typeof app.applicationId === "string"
            && app.applicationId.length > 0
            && /^[a-f0-9]{64}$/.test(app.externalEvidenceHash)
            && app.externalEvidenceHash === input.ownerEvidence.applicationHash
            && app.proposalHash === input.proposal.proposalHash
            && typeof app.surface === "string"
            && app.surface.length > 0
            && isCanonicalValue(app.target)
            && isCanonicalValue(app.value)
            && app.surface === input.proposal.recommendation.surface
            && sameCanonicalValue(app.target, input.proposal.recommendation.target)
            && sameCanonicalValue(app.value, input.proposal.recommendation.to));
        if (!matchingApplication) {
            return { ok: false, reason: "proposal_hash_mismatch" };
        }
        if (typeof input.ownerEvidence.applicationHash !== "string" || !/^[a-f0-9]{64}$/.test(input.ownerEvidence.applicationHash)) {
            return { ok: false, reason: "trial_malformed" };
        }
        // Owner authority asserted via explicit ownerEvidence binding the exact proposal.
        // No mutation, no apply path performed or implied. Validate then evaluate the trial.
        const trialInput = {
            proposal: input.proposal,
            currentTarget: input.currentTarget,
            currentGuards: input.currentGuards,
            occurrences: input.occurrences,
            distinctRuns: input.distinctRuns,
            ageDays: input.ageDays,
            minEffect: input.minEffect,
            noiseFloor: input.noiseFloor,
        };
        return evaluateTrial(trialInput);
    }
    catch {
        return { ok: false, reason: "trial_malformed" };
    }
}
