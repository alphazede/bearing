export const METRIC_IDS = Object.freeze([
    "coordination-overhead",
    "first-pass-success",
    "grading-accuracy",
    "escaped-defects",
    "cost-per-accepted-criterion",
]);
function nonNegativeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function positiveInteger(value) {
    return nonNegativeInteger(value) && value > 0;
}
function reference(value) {
    return typeof value === "string" && value.length > 0;
}
function metric(id, numerator, denominator, sourceAvailable) {
    const sufficient = sourceAvailable && denominator > 0;
    return Object.freeze({
        id,
        numerator,
        denominator,
        sufficient,
        value: sufficient ? numerator / denominator : null,
    });
}
function coordinationOverhead(input) {
    let numerator = 0;
    let denominator = 0;
    for (const observation of input) {
        if (!positiveInteger(observation.estimatedAgents)
            || !nonNegativeInteger(observation.workItems)
            || observation.workItems > observation.estimatedAgents)
            continue;
        numerator += observation.estimatedAgents - observation.workItems;
        denominator += observation.estimatedAgents;
    }
    return metric("coordination-overhead", numerator, denominator, true);
}
function firstPassSuccess(input) {
    const firstBySlice = new Map();
    for (const observation of input) {
        if (!reference(observation.sliceRef)
            || !positiveInteger(observation.attempt)
            || (observation.status !== "complete" && observation.status !== "failed")
            || firstBySlice.has(observation.sliceRef))
            continue;
        firstBySlice.set(observation.sliceRef, observation);
    }
    let numerator = 0;
    for (const observation of firstBySlice.values()) {
        if (observation.attempt === 1 && observation.status === "complete")
            numerator += 1;
    }
    return metric("first-pass-success", numerator, firstBySlice.size, true);
}
function gradingAccuracy(input) {
    let truePositive = 0;
    let trueNegative = 0;
    let falsePositive = 0;
    let falseNegative = 0;
    for (const observation of input) {
        if (!reference(observation.sliceRef)
            || (observation.verdict !== "pass" && observation.verdict !== "fail")
            || !Object.hasOwn(observation, "groundTruth"))
            continue;
        const groundTruth = observation.groundTruth;
        if (groundTruth !== "pass" && groundTruth !== "fail")
            continue;
        // A confirmed defect is the positive class. A grader pass contradicted by
        // that later ground truth is therefore a false negative (an escaped miss).
        if (observation.verdict === "fail" && groundTruth === "fail")
            truePositive += 1;
        else if (observation.verdict === "pass" && groundTruth === "pass")
            trueNegative += 1;
        else if (observation.verdict === "fail")
            falsePositive += 1;
        else
            falseNegative += 1;
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
function acceptedCriteria(input) {
    const completedAt = new Map();
    const requirementRefs = new Map();
    const contributingRunRefs = new Set();
    for (const completion of input) {
        if (!reference(completion.sliceRef)
            || !nonNegativeInteger(completion.sequence)
            || !Array.isArray(completion.requirementRefs))
            continue;
        const refs = new Set(completion.requirementRefs.filter(reference));
        if (refs.size === 0)
            continue;
        const previous = completedAt.get(completion.sliceRef);
        if (previous !== undefined && previous <= completion.sequence)
            continue;
        completedAt.set(completion.sliceRef, completion.sequence);
        requirementRefs.set(completion.sliceRef, refs);
        contributingRunRefs.add(completion.runRef ?? "");
    }
    let denominator = 0;
    for (const refs of requirementRefs.values())
        denominator += refs.size;
    return { denominator, completedAt, contributingRunRefs };
}
function escapedDefects(input, criteria, sourceAvailable) {
    let numerator = 0;
    for (const finding of input ?? []) {
        if (!reference(finding.sliceRef) || !nonNegativeInteger(finding.sequence))
            continue;
        const completedAt = criteria.completedAt.get(finding.sliceRef);
        if (completedAt !== undefined && finding.sequence > completedAt)
            numerator += 1;
    }
    return metric("escaped-defects", numerator, criteria.denominator, sourceAvailable);
}
function costPerAcceptedCriterion(input, criteria, coverageComplete) {
    let numerator = 0;
    const coveredRunRefs = new Set();
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
export function computeMetrics(input) {
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
        escapedDefects: escapedDefects(findingSignalsAvailable ? input.confirmedFindings : [], criteria, findingSignalsAvailable && reviewCoverageAvailable),
        costPerAcceptedCriterion: costPerAcceptedCriterion(input.tokenReports, criteria, input.tokenCoverageComplete !== false),
    });
}
