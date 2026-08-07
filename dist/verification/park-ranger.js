import { selectGraderRoute } from "./grader.js";
import { assertIndependentVerification, assertIsolatedVerification, } from "./verification-roles.js";
import { isObject } from "../contracts/guards.js";
const MAX_ITEMS = 128;
const MAX_TEXT = 16_384;
const MAX_TRAVERSAL_DEPTH = 128;
const EXECUTION_SLICE_ID = /^(?:[A-Za-z]+\d+|\d+(?:\.\d+)+)$/;
const PRIORITY_ORDER = {
    P0: 0,
    P1: 1,
    P2: 2,
    P3: 3,
};
const LENS_ORDER = [
    "correctness",
    "security",
    "test-strength",
    "cross-file-invariant",
    "native-review",
];
const FINDING_KEYS = [
    "id",
    "priority",
    "summary",
    "location",
    "reproduction",
    "reachability",
    "sliceIds",
    "lens",
    "confirmedBy",
];
const FINDING_OPTIONAL_KEYS = ["code", "testStrength", "reasons", "regressionRisk"];
const REGRESSION_RISK_KEYS = ["behavior", "verifiedBy"];
const LOCATION_KEYS = ["path", "line"];
const REPRODUCTION_KEYS = ["inputs", "observedFailure"];
const REPRODUCTION_OPTIONAL_KEYS = ["commandId"];
const REACHABILITY_KEYS = ["entryPoint", "trustBoundary", "path"];
const QUESTION_KEYS = ["id", "summary", "location", "lens"];
const QUESTION_OPTIONAL_KEYS = ["testStrength"];
const LENS_REPORT_KEYS = ["lens", "sessionId", "findings", "questions"];
const PARK_RANGER_REPORT_KEYS = [...LENS_REPORT_KEYS, "adjudications"];
const ADJUDICATION_KEYS = ["claim", "verdict", "reasons"];
const CLAIM_KEYS = ["text", "sliceIds"];
const P0_DEMOTION_REASON = "p0_requires_two_confirming_lenses";
const EMPTY_INDEPENDENCE = {
    implementerSessionIds: [],
    executionAncestry: [],
};
function hasAllowedKeys(value, required, optional = []) {
    if (!isObject(value))
        return false;
    const allowed = new Set([...required, ...optional]);
    return Object.keys(value).every((key) => allowed.has(key))
        && required.every((key) => Object.hasOwn(value, key));
}
function hasUnexpectedKeys(value, allowed) {
    return isObject(value) && Object.keys(value).some((key) => !allowed.includes(key));
}
function objectGraphFailure(value, ancestors = new WeakSet(), depth = 0) {
    if (typeof value !== "object" || value === null)
        return undefined;
    if (depth > MAX_TRAVERSAL_DEPTH)
        return "malformed";
    if (ancestors.has(value))
        return "prototype_pollution";
    if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype)
            return "prototype_pollution";
    }
    else {
        const prototype = Object.getPrototypeOf(value);
        if ((prototype !== Object.prototype && prototype !== null) || Object.hasOwn(value, "__proto__")) {
            return "prototype_pollution";
        }
    }
    ancestors.add(value);
    try {
        for (const key of Object.keys(value)) {
            const failure = objectGraphFailure(value[key], ancestors, depth + 1);
            if (failure !== undefined)
                return failure;
        }
        return undefined;
    }
    finally {
        ancestors.delete(value);
    }
}
function boundedText(value) {
    return typeof value === "string"
        && value.length > 0
        && value.length <= MAX_TEXT
        && value === value.trim()
        && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}
function denseArray(value, predicate) {
    if (!Array.isArray(value)
        || Object.getPrototypeOf(value) !== Array.prototype
        || value.length > MAX_ITEMS
        || Object.keys(value).length !== value.length)
        return false;
    for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index) || !predicate(value[index]))
            return false;
    }
    return true;
}
function isLensId(value) {
    return typeof value === "string" && LENS_ORDER.includes(value);
}
function isPriority(value) {
    return value === "P0" || value === "P1" || value === "P2" || value === "P3";
}
function isTrustBoundary(value) {
    return value === "untrusted-input" || value === "in-process" || value === "local-only";
}
function isTestStrengthCode(value) {
    return value === "tautological_assertion"
        || value === "missing_negative_case"
        || value === "failure_path_uncovered";
}
function locationShape(value) {
    return hasAllowedKeys(value, LOCATION_KEYS)
        && boundedText(value.path)
        && Number.isSafeInteger(value.line)
        && value.line > 0;
}
function reproductionShape(value) {
    return hasAllowedKeys(value, REPRODUCTION_KEYS, REPRODUCTION_OPTIONAL_KEYS)
        && boundedText(value.inputs)
        && boundedText(value.observedFailure)
        && (!Object.hasOwn(value, "commandId") || boundedText(value.commandId));
}
function reachabilityShape(value) {
    return hasAllowedKeys(value, REACHABILITY_KEYS)
        && boundedText(value.entryPoint)
        && isTrustBoundary(value.trustBoundary)
        && denseArray(value.path, boundedText)
        && value.path.length > 0;
}
function findingSliceIdsShape(value) {
    return denseArray(value, (entry) => typeof entry === "string"
        && entry.length > 0
        && entry.length <= 128
        && EXECUTION_SLICE_ID.test(entry))
        && value.length > 0
        && new Set(value).size === value.length;
}
function findingShape(value) {
    return hasAllowedKeys(value, FINDING_KEYS, FINDING_OPTIONAL_KEYS)
        && boundedText(value.id)
        && (!Object.hasOwn(value, "code") || boundedText(value.code))
        && isPriority(value.priority)
        && boundedText(value.summary)
        && locationShape(value.location)
        && reproductionShape(value.reproduction)
        && reachabilityShape(value.reachability)
        && findingSliceIdsShape(value.sliceIds)
        && isLensId(value.lens)
        && denseArray(value.confirmedBy, isLensId)
        && (!Object.hasOwn(value, "testStrength") || isTestStrengthCode(value.testStrength))
        && (!Object.hasOwn(value, "reasons") || denseArray(value.reasons, boundedText))
        && (!Object.hasOwn(value, "regressionRisk") || regressionRiskShape(value.regressionRisk));
}
function regressionRiskShape(value) {
    return hasAllowedKeys(value, REGRESSION_RISK_KEYS)
        && boundedText(value.behavior)
        && boundedText(value.verifiedBy);
}
function questionShape(value) {
    return hasAllowedKeys(value, QUESTION_KEYS, QUESTION_OPTIONAL_KEYS)
        && boundedText(value.id)
        && boundedText(value.summary)
        && locationShape(value.location)
        && isLensId(value.lens)
        && (!Object.hasOwn(value, "testStrength") || isTestStrengthCode(value.testStrength));
}
function claimShape(value) {
    return hasAllowedKeys(value, CLAIM_KEYS)
        && boundedText(value.text)
        && denseArray(value.sliceIds, boundedText);
}
function adjudicationShape(value) {
    return hasAllowedKeys(value, ADJUDICATION_KEYS)
        && claimShape(value.claim)
        && (value.verdict === "supported" || value.verdict === "unsupported" || value.verdict === "insufficient_evidence")
        && denseArray(value.reasons, boundedText);
}
function nestedUnexpectedKey(value) {
    const findings = value.findings;
    if (Array.isArray(findings) && findings.some((finding) => {
        if (!isObject(finding))
            return false;
        if (hasUnexpectedKeys(finding, [...FINDING_KEYS, ...FINDING_OPTIONAL_KEYS]))
            return true;
        if (hasUnexpectedKeys(finding.location, LOCATION_KEYS))
            return true;
        if (hasUnexpectedKeys(finding.reproduction, [...REPRODUCTION_KEYS, ...REPRODUCTION_OPTIONAL_KEYS]))
            return true;
        if (hasUnexpectedKeys(finding.regressionRisk, REGRESSION_RISK_KEYS))
            return true;
        return hasUnexpectedKeys(finding.reachability, REACHABILITY_KEYS);
    }))
        return true;
    const questions = value.questions;
    if (Array.isArray(questions) && questions.some((question) => isObject(question)
        && (hasUnexpectedKeys(question, [...QUESTION_KEYS, ...QUESTION_OPTIONAL_KEYS])
            || hasUnexpectedKeys(question.location, LOCATION_KEYS))))
        return true;
    const adjudications = value.adjudications;
    return Array.isArray(adjudications) && adjudications.some((adjudication) => isObject(adjudication)
        && (hasUnexpectedKeys(adjudication, ADJUDICATION_KEYS)
            || hasUnexpectedKeys(adjudication.claim, CLAIM_KEYS)));
}
function reproductionFailure(value) {
    if (!Array.isArray(value.findings))
        return false;
    return value.findings.some((finding) => isObject(finding)
        && isObject(finding.reproduction)
        && ((typeof finding.reproduction.inputs === "string" && finding.reproduction.inputs.trim().length === 0)
            || (typeof finding.reproduction.observedFailure === "string" && finding.reproduction.observedFailure.trim().length === 0)));
}
function reachabilityFailure(value) {
    if (!Array.isArray(value.findings))
        return false;
    return value.findings.some((finding) => isObject(finding)
        && isObject(finding.reachability)
        && Array.isArray(finding.reachability.path)
        && finding.reachability.path.length === 0);
}
function findingSliceScopeFailure(value) {
    if (!Array.isArray(value.findings))
        return false;
    return value.findings.some((finding) => isObject(finding)
        && (!Object.hasOwn(finding, "sliceIds") || !findingSliceIdsShape(finding.sliceIds)));
}
function claimKey(claim) {
    return JSON.stringify([claim.text, claim.sliceIds]);
}
function independentLensReports(reports, independence) {
    for (const report of reports) {
        const result = assertIndependentVerification({
            verifierSessionId: report.sessionId,
            implementerSessionIds: independence.implementerSessionIds,
            executionAncestry: independence.executionAncestry,
        });
        if (!result.ok)
            return result;
    }
    return { ok: true };
}
function normalizeFinding(finding, confirmingLens = finding.lens) {
    const reasons = finding.reasons === undefined ? undefined : [...new Set(finding.reasons)].sort();
    return {
        ...finding,
        sliceIds: [...finding.sliceIds].sort(compareText),
        priority: clampPriority(finding.priority, finding.reachability.trustBoundary),
        confirmedBy: [confirmingLens],
        ...(reasons === undefined ? {} : { reasons }),
    };
}
export function parseParkRangerReport(value, inboundClaims = [], independence = EMPTY_INDEPENDENCE, allowedSliceIds) {
    const objectFailure = objectGraphFailure(value)
        ?? objectGraphFailure(inboundClaims)
        ?? objectGraphFailure(independence);
    if (objectFailure !== undefined)
        return { ok: false, reason: objectFailure };
    if (!isObject(value))
        return { ok: false, reason: "malformed" };
    if (hasUnexpectedKeys(value, PARK_RANGER_REPORT_KEYS) || nestedUnexpectedKey(value)) {
        return { ok: false, reason: "unexpected_key" };
    }
    if (reproductionFailure(value))
        return { ok: false, reason: "finding_unreproduced" };
    if (reachabilityFailure(value))
        return { ok: false, reason: "finding_unreachable" };
    if (findingSliceScopeFailure(value))
        return { ok: false, reason: "finding_slice_scope_invalid" };
    if (!hasAllowedKeys(value, PARK_RANGER_REPORT_KEYS)
        || !isLensId(value.lens)
        || !boundedText(value.sessionId)
        || !denseArray(value.findings, findingShape)
        || value.findings.some((finding) => finding.lens !== value.lens)
        || !denseArray(value.questions, questionShape)
        || value.questions.some((question) => question.lens !== value.lens)
        || !denseArray(value.adjudications, adjudicationShape)
        || !denseArray(inboundClaims, claimShape)
        || !denseArray(independence.implementerSessionIds, boundedText)
        || !denseArray(independence.executionAncestry, boundedText)) {
        return { ok: false, reason: "malformed" };
    }
    const independent = independentLensReports([value], independence);
    if (!independent.ok)
        return { ok: false, reason: independent.code };
    const adjudicated = new Set(value.adjudications.map(({ claim }) => claimKey(claim)));
    if (inboundClaims.some((claim) => !adjudicated.has(claimKey(claim)))) {
        return { ok: false, reason: "claim_unadjudicated" };
    }
    const report = value;
    if (allowedSliceIds !== undefined) {
        const allowed = new Set(allowedSliceIds);
        if (report.findings.some((finding) => finding.sliceIds.some((sliceId) => !allowed.has(sliceId)))) {
            return { ok: false, reason: "unknown_slice" };
        }
    }
    return {
        ok: true,
        value: {
            ...report,
            findings: report.findings.map((finding) => ({
                ...finding,
                sliceIds: [...finding.sliceIds].sort(compareText),
            })),
        },
    };
}
export function adjudicateClaim(input) {
    const reasons = [];
    const claimSliceIds = new Set(input.claim.sliceIds);
    const blockingPriorities = [...new Set(input.findings
            .map((finding) => normalizeFinding(finding))
            .filter((finding) => finding.sliceIds.some((sliceId) => claimSliceIds.has(sliceId)))
            .filter(({ priority }) => priority === "P0" || priority === "P1")
            .map(({ priority }) => `open_${priority.toLowerCase()}_finding`))].sort();
    if (blockingPriorities.length > 0)
        reasons.push(...blockingPriorities);
    if (input.validator.verdict === "FAIL")
        reasons.push("validator_failed");
    if (input.claim.sliceIds.length === 0)
        reasons.push("claim_scope_empty");
    const validatedSliceIds = new Set(input.validatedSliceIds);
    if (input.claim.sliceIds.some((sliceId) => !validatedSliceIds.has(sliceId))) {
        reasons.push("claim_scope_unvalidated");
    }
    if (reasons.length > 0)
        return { verdict: "unsupported", reasons };
    if (input.validator.verdict === "NEEDS_MORE_EVIDENCE") {
        return { verdict: "insufficient_evidence", reasons: ["validator_needs_more_evidence"] };
    }
    return { verdict: "supported", reasons: [] };
}
export function clampPriority(priority, boundary) {
    if (boundary === "untrusted-input")
        return priority;
    if (boundary === "in-process" && priority === "P0")
        return "P1";
    if (boundary === "local-only" && (priority === "P0" || priority === "P1"))
        return "P2";
    return priority;
}
function findingCode(finding) {
    return finding.code ?? finding.testStrength ?? finding.id;
}
/**
 * Normalizes a finding's repository-relative path to one canonical POSIX
 * spelling: backslashes become slashes, a leading "./" is stripped, and
 * duplicate slashes collapse. Without this, `src/journey/a.ts`,
 * `./src/journey/b.ts`, `src\journey\c.ts`, and `src//journey//d.ts` would
 * fingerprint and classify as four different locations and subsystems, so the
 * convergence chain could never see them as related.
 */
function canonicalFindingPath(path) {
    return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
}
export function findingIdentity(finding) {
    return JSON.stringify([canonicalFindingPath(finding.location.path), finding.location.line, findingCode(finding)]);
}
// --- Review-repair convergence guard -----------------------------------------
//
// A repair round fixes one defect and the next review round finds the next one in the same
// subsystem — see `regressionRisk`, whose whole point is that a repair can trade one bug for
// another. Nothing before this guard compared one cycle's findings with the prior cycles'
// fingerprints, so the cycle could run indefinitely without ever surfacing that it is not
// converging. This guard classifies each new P1/P2 finding as repeated/related/new against the
// prior cycles' fingerprints, counts consecutive non-converging cycles, and emits a typed,
// bounded `non_convergence` condition once the count reaches a configurable threshold. The
// condition is a surfaced typed signal carrying one bounded consolidate-or-stop action — never
// an enforcement gate and never a stop that discards evidence.
export const DEFAULT_CONVERGENCE_THRESHOLD = 3;
export const MAX_CONVERGENCE_CYCLES = 16;
export const MAX_CYCLE_FINDINGS = 64;
const MAX_TRACKED_FINDINGS = MAX_CONVERGENCE_CYCLES * MAX_CYCLE_FINDINGS;
export const EMPTY_CONVERGENCE_HISTORY = { tracked: [], chain: 0 };
export function findingSeverityClass(priority) {
    return priority === "P1" || priority === "P2" ? "repair-relevant" : "other";
}
export function findingSubsystem(finding) {
    const path = canonicalFindingPath(finding.location.path);
    const segments = path.split("/");
    const subsystem = segments.slice(0, -1).join("/");
    return subsystem === "" ? path : subsystem;
}
function classifyFinding(finding, prior) {
    const fingerprint = findingIdentity(finding);
    const subsystem = findingSubsystem(finding);
    const severityClass = findingSeverityClass(finding.priority);
    const relation = prior.some((tracked) => tracked.fingerprint === fingerprint)
        ? "repeated"
        : prior.some((tracked) => tracked.severityClass === severityClass && tracked.subsystem === subsystem)
            ? "related"
            : "new";
    return { fingerprint, priority: finding.priority, severityClass, subsystem, relation };
}
function dominantSubsystem(classified) {
    const counts = new Map();
    for (const { subsystem } of classified)
        counts.set(subsystem, (counts.get(subsystem) ?? 0) + 1);
    let dominant = classified[0].subsystem;
    for (const [subsystem, count] of counts) {
        const dominantCount = counts.get(dominant) ?? 0;
        if (count > dominantCount || (count === dominantCount && subsystem < dominant))
            dominant = subsystem;
    }
    return dominant;
}
/**
 * Advances the run's convergence history by one review-repair cycle. The caller owns the history
 * across cycles (run-scoped state threaded by the orchestration layer) and receives the updated
 * history plus, once the chain reaches the threshold, the typed `non_convergence` condition.
 * Classification happens against `history.tracked` only — never against the current cycle — so a
 * finding can only repeat or relate to something an earlier cycle already reported.
 */
export function recordReviewCycle(history, cycleFindings, threshold = DEFAULT_CONVERGENCE_THRESHOLD) {
    if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > MAX_CONVERGENCE_CYCLES) {
        return { ok: false, reason: "convergence_threshold_invalid" };
    }
    const classified = cycleFindings
        .filter((finding) => finding.priority === "P1" || finding.priority === "P2")
        .map((finding) => classifyFinding(finding, history.tracked))
        .sort((left, right) => compareText(left.fingerprint, right.fingerprint))
        .filter((finding, index, all) => index === 0 || all[index - 1].fingerprint !== finding.fingerprint)
        .slice(0, MAX_CYCLE_FINDINGS);
    // The chain advances only when the cycle reports at least one P1/P2 finding and every one of
    // them repeated or related to a prior cycle. A genuinely new finding — or a cycle with no
    // repair-relevant findings at all — is progress, and the chain resets to zero.
    const chain = classified.length > 0 && classified.every(({ relation }) => relation !== "new")
        ? history.chain + 1
        : 0;
    // Newest last, oldest dropped past the cap, so the guard stays bounded however long a
    // misbehaving run keeps cycling.
    const tracked = [...history.tracked, ...classified].slice(-MAX_TRACKED_FINDINGS);
    const value = {
        history: { tracked, chain },
    };
    if (chain < threshold)
        return { ok: true, value };
    return {
        ok: true,
        value: {
            ...value,
            condition: {
                type: "non_convergence",
                cycleCount: chain,
                fingerprints: classified.map(({ fingerprint }) => fingerprint),
                subsystem: dominantSubsystem(classified),
                findings: classified,
                action: chain === threshold ? "consolidate" : "stop",
            },
        },
    };
}
function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function compareFindings(left, right) {
    return PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority]
        || compareText(left.location.path, right.location.path)
        || left.location.line - right.location.line
        || compareText(left.id, right.id);
}
function compareQuestions(left, right) {
    return compareText(left.location.path, right.location.path)
        || left.location.line - right.location.line
        || compareText(left.id, right.id)
        || compareText(left.lens, right.lens);
}
export function synthesizeFindings(lensReports, independence = EMPTY_INDEPENDENCE) {
    const independent = independentLensReports(lensReports, independence);
    if (!independent.ok)
        return { ok: false, reason: independent.code };
    const candidates = lensReports
        .flatMap((report) => report.findings.map((finding) => normalizeFinding(finding, report.lens)))
        .sort(compareFindings);
    const deduplicated = new Map();
    for (const candidate of candidates) {
        if (candidate.reproduction.inputs.trim().length === 0 || candidate.reproduction.observedFailure.trim().length === 0) {
            return { ok: false, reason: "finding_unreproduced" };
        }
        if (candidate.reachability.path.length === 0)
            return { ok: false, reason: "finding_unreachable" };
        const key = findingIdentity(candidate);
        const existing = deduplicated.get(key);
        if (!existing) {
            deduplicated.set(key, candidate);
            continue;
        }
        const confirmedBy = [...new Set([...existing.confirmedBy, ...candidate.confirmedBy])]
            .sort((left, right) => LENS_ORDER.indexOf(left) - LENS_ORDER.indexOf(right));
        const priority = PRIORITY_ORDER[candidate.priority] < PRIORITY_ORDER[existing.priority]
            ? candidate.priority
            : existing.priority;
        const reasons = [...new Set([...(existing.reasons ?? []), ...(candidate.reasons ?? [])])].sort();
        const sliceIds = [...new Set([...existing.sliceIds, ...candidate.sliceIds])].sort(compareText);
        deduplicated.set(key, {
            ...existing,
            priority,
            sliceIds,
            confirmedBy,
            ...(reasons.length === 0 ? {} : { reasons }),
        });
    }
    const findings = [...deduplicated.values()].map((finding) => {
        if (finding.priority !== "P0" || finding.confirmedBy.length >= 2)
            return finding;
        return {
            ...finding,
            priority: "P1",
            reasons: [...new Set([...(finding.reasons ?? []), P0_DEMOTION_REASON])].sort(),
        };
    }).sort(compareFindings);
    const questions = lensReports.flatMap(({ questions: reportQuestions }) => reportQuestions).sort(compareQuestions);
    const verdict = findings.some(({ priority }) => priority === "P0")
        ? "block"
        : findings.some(({ priority }) => priority === "P1")
            ? "repair-required"
            : findings.length > 0
                ? "accept-with-findings"
                : "accept";
    return { ok: true, value: { findings, questions, verdict } };
}
export function assertParkRangerCleanRoom(input) {
    const isolated = assertIsolatedVerification({
        role: input.role,
        ...(input.providerSessionId === undefined ? {} : { providerSessionId: input.providerSessionId }),
        ...(input.focusMode === undefined ? {} : { focusMode: input.focusMode }),
    });
    if (!isolated.ok)
        return isolated;
    return independentLensReports(input.lensReports, input.independence);
}
export function selectParkRangerRoute(input) {
    return selectGraderRoute(input);
}
