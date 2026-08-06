import { BUILTIN_ROUTES } from "../adapters/adapters.js";
export const SKILL_LIFECYCLE_SCHEMA_VERSION = 1;
export const SKILL_NAMES = [
    "repository-fit", "set-bearings", "gather-supplies", "map-the-route", "navigator",
    "explorer", "crewmate", "validator", "grader", "park-ranger", "surveyor",
];
const source = (sha256, lines) => ({ sha256, lines });
const characterization = (name, customerLabel, rationale, why, when, how, negativeNonTrigger, sha256, lines) => ({
    name, customerLabel, classification: "preference", rationale,
    directives: { why, when, how, negativeNonTrigger }, source: source(sha256, lines),
    noOp: "none found", humanReview: "pending", changeStatus: "unchanged", compatibility: "canonical-only", retirement: "not-eligible",
});
/** Pinned characterization of the eleven workflow skills shipped in this package. */
export const SKILL_CHARACTERIZATION_MANIFEST = {
    schemaVersion: SKILL_LIFECYCLE_SCHEMA_VERSION,
    skills: [
        characterization("repository-fit", "Repository Fit", "Repository and plan-directory confirmation policy.", "Propose a repository fit for owner confirmation.", "Bearing enters Repository Fit.", "Use bounded evidence to return one assumption and question.", "Do not trigger after repository fit is confirmed.", "ca97c3078890baf8ad6b9e403d58e0c0ec8080abe176decec1eea23284c3155a", 52),
        characterization("set-bearings", "Set Bearings", "Bounded workspace and repository-map policy.", "Start or resume a plan workspace.", "Bearing enters Set Bearings.", "Create only the workspace, stub, and repository map.", "Do not trigger for a tentative planning discussion.", "1476fca2c51157c8f2d1d27b4d8abe3a395967d185db0045d8244696e6620c74", 71),
        characterization("gather-supplies", "Gather Supplies", "Material-decision and specification policy.", "Harden a plan specification.", "Bearing enters Gather Supplies.", "Resolve only material decisions and write the specification.", "Do not trigger for a request to merely summarize documentation.", "2179cafeeff6e5159fa005768b4685166d578c2d3f5056b2eaafdf25d15a82aa", 77),
        characterization("map-the-route", "Map the Route", "Design, SEIT, and implementation-route policy.", "Design an approved plan.", "Bearing enters Map the Route.", "Write design and SEIT, then draft implementation after validation.", "Do not trigger for a request to execute an existing route.", "5129f55d3e257d7366d40f71c0fa0f622f3d54c4111e80bb24ec9186d22d707d", 89),
        characterization("navigator", "Navigator", "Dependent-wave execution and authority policy.", "Run dependent implementation waves.", "The owner selects Expedition.", "Coordinate independent Explorer lanes by wave.", "Do not trigger for one bounded route with no parallel lanes.", "1f0b85cafa4180996e1bd4f0e4f09bd70c473da2dad1c8cfe93dda1d8ea1274d", 111),
        characterization("explorer", "Explorer", "Bounded route execution and validation policy.", "Execute one approved route.", "The owner selects Explorer or Navigator delegates a lane.", "Apply Crewmate packets, inspect diffs, and validate.", "Do not trigger for unapproved multi-wave planning.", "0d33e28c08797f4f2e44dd971dd88e78226af22eaf9ab708874cb397f7c239bd", 76),
        characterization("crewmate", "Crewmate", "Bounded implementation-role and scope policy.", "Make one approved change.", "Explorer or Navigator assigns a settled coding packet.", "Edit only allowed paths and return validation evidence.", "Do not trigger for an unresolved design decision.", "0a6f3cd382d86d82a3155bc00f19beea4f1b2a5c2db64d1834dad86445622faf", 89),
        characterization("validator", "Validator", "Scope-sufficiency verification policy over the deterministic boundary.", "Verify scope sufficiency after per-slice completion.", "Integrated work reaches the verification cadence.", "Wrap FocusCompletion and add the four scope checks, then return a typed verdict.", "Do not trigger to recompute containment or command evidence.", "8d6f8fd8db748d12ed1d859bd9b842c36bf135ccd3e251fe24dccb17a15d7555", 53),
        characterization("grader", "Grader", "Rubric scoring and verdict-arithmetic policy.", "Score a supplied report against the versioned rubric.", "A grader report is submitted for verification.", "Recompute the weighted verdict and reject mismatch or pollution.", "Do not trigger to repair code or decide a transition.", "c90c722109d04ddfa7c6aad73f1b4d990e924bff73cbb2efadb63ebbd06dea29", 53),
        characterization("park-ranger", "Park Ranger", "Reproduction and finding-synthesis policy.", "Adjudicate reproduced findings across lenses.", "Lens reports are ready for synthesis.", "Require reproduction, clamp priority, and synthesize a stable order.", "Do not trigger to promote an unreproduced suspicion.", "566d2aa6fa00a683c0ce915da46574871091dcfa49883e21f1b22fa4a1426691", 53),
        characterization("surveyor", "Surveyor", "Independent read-only review policy.", "Review completed integrated work.", "The selected harness lacks a native reviewer.", "Review once and report verified actionable findings.", "Do not trigger when a native review is available.", "80f7b09688cf5a3cc244c8d14f0b08aeec88222d61d7c0ca646d1cc8587bd186", 93),
    ],
};
const cases = (skill, positive, negative, invariant) => [
    { id: `${skill}:positive`, skill, kind: "positive", prompt: positive, expected: "trigger", invariant },
    { id: `${skill}:negative`, skill, kind: "negative", prompt: negative, expected: "do-not-trigger", invariant },
];
/** Exactly one outcome-graded positive and negative case for every skill. */
export const NATIVE_SKILL_CHARACTERIZATION_CASES = [
    ...cases("repository-fit", "Use Repository Fit to propose the account-export repository and plan directory.", "Repository fit is already confirmed; start Set Bearings.", "does not create or confirm the plan directory"),
    ...cases("set-bearings", "Use Set Bearings to start an account-export plan.", "We should eventually plan account export.", "does not draft downstream artifacts"),
    ...cases("gather-supplies", "Use Gather Supplies on the account-export plan stub.", "Summarize the account-export docs for me.", "does not resolve owner decisions without evidence"),
    ...cases("map-the-route", "Use Map the Route on this approved account-export specification.", "Implement the approved account-export design.", "does not execute implementation slices"),
    ...cases("navigator", "Use Navigator for the approved multi-wave account-export route.", "Implement this one bounded account-export test fix.", "does not coordinate waves for standalone work"),
    ...cases("explorer", "Use Explorer to complete this approved account-export route.", "Design a multi-wave account-export program.", "does not expand the approved route"),
    ...cases("crewmate", "Use Crewmate for the approved account-export packet in its allowed paths.", "Choose the account-export architecture before coding.", "does not edit outside allowed paths"),
    ...cases("validator", "Use the Validator to check scope sufficiency for the completed account-export slice.", "Recompute containment for the account-export focus result.", "does not recompute the deterministic boundary"),
    ...cases("grader", "Use the Grader to score the submitted account-export grader report.", "Repair the account-export code the report flagged.", "does not repair code or decide transitions"),
    ...cases("park-ranger", "Use Park Ranger to synthesize the account-export lens findings.", "Promote an unreproduced account-export suspicion to a finding.", "does not promote unreproduced suspicions"),
    ...cases("surveyor", "Use Surveyor to review the completed account-export diff.", "Edit the account-export documentation wording.", "does not modify reviewed work"),
];
const ROUTES = BUILTIN_ROUTES.map(({ id }) => id);
const ARMS = ["without-skill", "with-skill"];
const CASE_IDS = NATIVE_SKILL_CHARACTERIZATION_CASES.map(({ id }) => id);
function object(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exact(value, keys) { return object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)); }
function text(value) { return typeof value === "string" && value.length > 0 && value.length <= 128; }
function exactSet(values, expected) { return values.length === expected.length && new Set(values).size === values.length && expected.every((value) => values.includes(value)); }
function completeEvidence(value) {
    if (!exact(value, ["schemaVersion", "change", "ownerApproval", "aliasRemovalApproval", "referenceMigration", "routes"]))
        return false;
    if (value.schemaVersion !== SKILL_LIFECYCLE_SCHEMA_VERSION || !["rename", "content-optimization", "alias-removal", "retirement"].includes(value.change) || typeof value.ownerApproval !== "boolean" || typeof value.aliasRemovalApproval !== "boolean" || !["complete", "incomplete"].includes(value.referenceMigration) || !Array.isArray(value.routes))
        return false;
    if (!exactSet(value.routes.map((route) => object(route) && typeof route.route === "string" ? route.route : ""), ROUTES))
        return false;
    return value.routes.every((route) => validRoute(route));
}
function validRoute(value) {
    if (!exact(value, ["route", "identity", "readiness", "tasks"]) || !text(value.route) || !Array.isArray(value.tasks))
        return false;
    const identity = value.identity;
    if (!exact(identity, ["requested", "effective"]) || identity.requested !== value.route || identity.effective !== value.route)
        return false;
    if (!exact(value.readiness, ["kind", "receipt"]) || value.readiness.kind !== "verified-provider" || !text(value.readiness.receipt))
        return false;
    if (!exactSet(value.tasks.map((task) => object(task) && typeof task.caseId === "string" ? task.caseId : ""), CASE_IDS))
        return false;
    if (!value.tasks.every((task) => validTask(task, identity)))
        return false;
    return routeAverage(value.tasks, "with-skill") > routeAverage(value.tasks, "without-skill");
}
function validTask(value, routeIdentity) {
    if (!exact(value, ["caseId", "arms"]) || !Array.isArray(value.arms))
        return false;
    const arms = value.arms;
    const caseId = value.caseId;
    if (!text(caseId))
        return false;
    if (!exactSet(arms.map((arm) => object(arm) && typeof arm.arm === "string" ? arm.arm : ""), ARMS))
        return false;
    if (!arms.every((arm) => validArm(arm, caseId, routeIdentity)))
        return false;
    const [withoutSkill, withSkill] = ARMS.map((name) => arms.find((arm) => object(arm) && arm.arm === name));
    return average(withSkill.trials) >= average(withoutSkill.trials);
}
function average(trials) {
    return trials.reduce((total, trial) => total + trial.score, 0) / trials.length;
}
function routeAverage(tasks, arm) {
    return average(tasks.flatMap((task) => {
        const arms = task.arms;
        return (arms.find((entry) => entry.arm === arm)?.trials ?? []);
    }));
}
function validArm(value, caseId, routeIdentity) {
    if (!exact(value, ["arm", "trials"]) || !ARMS.includes(value.arm) || !Array.isArray(value.trials) || value.trials.length !== 3)
        return false;
    const trials = value.trials.map((trial) => object(trial) && typeof trial.trial === "number" ? trial.trial : 0);
    if (!exactSet(trials.map(String), ["1", "2", "3"]))
        return false;
    const expected = value.arm === "with-skill" && NATIVE_SKILL_CHARACTERIZATION_CASES.find((entry) => entry.id === caseId)?.expected === "trigger";
    return value.trials.every((trial) => exact(trial, ["trial", "identity", "trigger", "outcome", "criticalInvariantPassed", "score"])
        && [1, 2, 3].includes(trial.trial)
        && exact(trial.identity, ["requested", "effective"])
        && trial.identity.requested === routeIdentity.requested && trial.identity.effective === routeIdentity.effective
        && trial.trigger === expected && trial.outcome === "passed" && trial.criticalInvariantPassed === true
        && typeof trial.score === "number" && Number.isFinite(trial.score) && trial.score >= 0 && trial.score <= 1);
}
export class SkillLifecycleService {
    evaluateChange(input) {
        if (!completeEvidence(input))
            return { allowed: false, code: "input_invalid" };
        if (!input.ownerApproval)
            return { allowed: false, code: "owner_approval_missing" };
        if (input.referenceMigration !== "complete")
            return { allowed: false, code: "reference_migration_incomplete" };
        if (input.change === "alias-removal")
            return { allowed: false, code: "alias_removal_requires_gate" };
        if (input.change === "retirement")
            return { allowed: false, code: "retirement_unavailable" };
        return { allowed: false, code: "provider_evidence_unverified" };
    }
    mayRemove(input) {
        if (!completeEvidence(input))
            return { allowed: false, code: "input_invalid" };
        if (input.change !== "alias-removal")
            return { allowed: false, code: "alias_removal_requires_gate" };
        if (!input.ownerApproval || !input.aliasRemovalApproval)
            return { allowed: false, code: "owner_approval_missing" };
        if (input.referenceMigration !== "complete")
            return { allowed: false, code: "reference_migration_incomplete" };
        return { allowed: false, code: "provider_evidence_unverified" };
    }
    mayRetire(input) {
        if (!completeEvidence(input))
            return { allowed: false, code: "input_invalid" };
        if (input.change !== "retirement")
            return { allowed: false, code: "retirement_unavailable" };
        return { allowed: false, code: "retirement_unavailable" };
    }
}
export const evaluateSkillLifecycleChange = (input) => new SkillLifecycleService().evaluateChange(input);
