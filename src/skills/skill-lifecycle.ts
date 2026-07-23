import { BUILTIN_ROUTES } from "../adapters/adapters.js";

export const SKILL_LIFECYCLE_SCHEMA_VERSION = 1 as const;

export const SKILL_NAMES = [
  "set-bearings", "gather-supplies", "map-the-route", "navigator",
  "explorer", "crewmate", "surveyor",
] as const;
export type SkillName = (typeof SKILL_NAMES)[number];

type TriggerCase = {
  readonly id: string;
  readonly skill: SkillName;
  readonly kind: "positive" | "negative";
  readonly prompt: string;
  readonly expected: "trigger" | "do-not-trigger";
  readonly invariant: string;
};

export interface SkillCharacterization {
  readonly name: SkillName;
  readonly customerLabel: string;
  readonly classification: "capability" | "preference";
  readonly rationale: string;
  readonly directives: { readonly why: string; readonly when: string; readonly how: string; readonly negativeNonTrigger: string };
  readonly noOp: "none found";
  readonly source: { readonly sha256: string; readonly lines: number };
  readonly humanReview: "pending";
  readonly changeStatus: "unchanged";
  readonly compatibility: "canonical-only";
  readonly retirement: "not-eligible";
}

const source = (sha256: string, lines: number) => ({ sha256, lines });
const characterization = (
  name: SkillName, customerLabel: string, rationale: string, why: string, when: string, how: string, negativeNonTrigger: string,
  sha256: string, lines: number,
): SkillCharacterization => ({
  name, customerLabel, classification: "preference", rationale,
  directives: { why, when, how, negativeNonTrigger }, source: source(sha256, lines),
  noOp: "none found", humanReview: "pending", changeStatus: "unchanged", compatibility: "canonical-only", retirement: "not-eligible",
});

/** Pinned characterization of the seven workflow skills shipped in this package. */
export const SKILL_CHARACTERIZATION_MANIFEST = {
  schemaVersion: SKILL_LIFECYCLE_SCHEMA_VERSION,
  skills: [
    characterization("set-bearings", "Set Bearings", "Bounded workspace and repository-map policy.", "Start or resume a plan workspace.", "Bearing enters Set Bearings.", "Create only the workspace, stub, and repository map.", "Do not trigger for a tentative planning discussion.", "28e968fbb532c464f6d146d4f897c95b03c24d6d54cf10b799da538073f4198e", 14),
    characterization("gather-supplies", "Gather Supplies", "Material-decision and specification policy.", "Harden a plan specification.", "Bearing enters Gather Supplies.", "Resolve only material decisions and write the specification.", "Do not trigger for a request to merely summarize documentation.", "9c1be46f8e895fc88eceb178d4f8f019127986d2aac9c723c592dadf37d95774", 16),
    characterization("map-the-route", "Map the Route", "Design, SEIT, and implementation-route policy.", "Design an approved plan.", "Bearing enters Map the Route.", "Write design and SEIT, then draft implementation after validation.", "Do not trigger for a request to execute an existing route.", "5771ab35c2138fac7d9366e24be1acc70730881863dd367e777ad8799c310da8", 23),
    characterization("navigator", "Navigator", "Dependent-wave execution and authority policy.", "Run dependent implementation waves.", "The owner selects Expedition.", "Coordinate independent Explorer lanes by wave.", "Do not trigger for one bounded route with no parallel lanes.", "8a8361798f04711171e8c66c7bbec96fabc0100f17f9284d8b43a5dd601833a1", 18),
    characterization("explorer", "Explorer", "Bounded route execution and validation policy.", "Execute one approved route.", "The owner selects Explorer or Navigator delegates a lane.", "Apply Crewmate packets, inspect diffs, and validate.", "Do not trigger for unapproved multi-wave planning.", "26f5af019252490ddd49676e7e9acecfe8651be620470222ad598f8e77ca7600", 18),
    characterization("crewmate", "Crewmate", "Bounded implementation-role and scope policy.", "Make one approved change.", "Explorer or Navigator assigns a settled coding packet.", "Edit only allowed paths and return validation evidence.", "Do not trigger for an unresolved design decision.", "c1f0064032ca68876e936233be56a1ea8dfc1af9eea01e93c82a451303307b94", 18),
    characterization("surveyor", "Surveyor", "Independent read-only review policy.", "Review completed integrated work.", "The selected harness lacks a native reviewer.", "Review once and report verified actionable findings.", "Do not trigger when a native review is available.", "15d01c6a7bb5b7f1236fb106eb70d7be9d47e67577a22e34009f8f9ff1d4a023", 16),
  ] as const,
} as const;

const cases = (skill: SkillName, positive: string, negative: string, invariant: string): readonly TriggerCase[] => [
  { id: `${skill}:positive`, skill, kind: "positive", prompt: positive, expected: "trigger", invariant },
  { id: `${skill}:negative`, skill, kind: "negative", prompt: negative, expected: "do-not-trigger", invariant },
];

/** Exactly one outcome-graded positive and negative case for every skill. */
export const NATIVE_SKILL_CHARACTERIZATION_CASES = [
  ...cases("set-bearings", "Use Set Bearings to start an account-export plan.", "We should eventually plan account export.", "does not draft downstream artifacts"),
  ...cases("gather-supplies", "Use Gather Supplies on the account-export plan stub.", "Summarize the account-export docs for me.", "does not resolve owner decisions without evidence"),
  ...cases("map-the-route", "Use Map the Route on this approved account-export specification.", "Implement the approved account-export design.", "does not execute implementation slices"),
  ...cases("navigator", "Use Navigator for the approved multi-wave account-export route.", "Implement this one bounded account-export test fix.", "does not coordinate waves for standalone work"),
  ...cases("explorer", "Use Explorer to complete this approved account-export route.", "Design a multi-wave account-export program.", "does not expand the approved route"),
  ...cases("crewmate", "Use Crewmate for the approved account-export packet in its allowed paths.", "Choose the account-export architecture before coding.", "does not edit outside allowed paths"),
  ...cases("surveyor", "Use Surveyor to review the completed account-export diff.", "Edit the account-export documentation wording.", "does not modify reviewed work"),
] as const;

export type LifecycleChange = "rename" | "content-optimization" | "alias-removal" | "retirement";
type Arm = "without-skill" | "with-skill";
const ROUTES = BUILTIN_ROUTES.map(({ id }) => id);
const ARMS = ["without-skill", "with-skill"] as const;

export interface SkillLifecycleInput {
  readonly schemaVersion: 1;
  readonly change: LifecycleChange;
  readonly ownerApproval: boolean;
  readonly aliasRemovalApproval: boolean;
  readonly referenceMigration: "complete" | "incomplete";
  readonly routes: readonly unknown[];
}

export type LifecycleDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: "input_invalid" | "owner_approval_missing" | "reference_migration_incomplete" | "alias_removal_requires_gate" | "retirement_unavailable" | "provider_evidence_unverified" };

const CASE_IDS = NATIVE_SKILL_CHARACTERIZATION_CASES.map(({ id }) => id);
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> { return object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)); }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 128; }
function exactSet(values: readonly string[], expected: readonly string[]): boolean { return values.length === expected.length && new Set(values).size === values.length && expected.every((value) => values.includes(value)); }

function completeEvidence(value: unknown): value is SkillLifecycleInput {
  if (!exact(value, ["schemaVersion", "change", "ownerApproval", "aliasRemovalApproval", "referenceMigration", "routes"])) return false;
  if (value.schemaVersion !== SKILL_LIFECYCLE_SCHEMA_VERSION || !["rename", "content-optimization", "alias-removal", "retirement"].includes(value.change as string) || typeof value.ownerApproval !== "boolean" || typeof value.aliasRemovalApproval !== "boolean" || !["complete", "incomplete"].includes(value.referenceMigration as string) || !Array.isArray(value.routes)) return false;
  if (!exactSet(value.routes.map((route) => object(route) && typeof route.route === "string" ? route.route : ""), ROUTES)) return false;
  return value.routes.every((route) => validRoute(route));
}

function validRoute(value: unknown): boolean {
  if (!exact(value, ["route", "identity", "readiness", "tasks"]) || !text(value.route) || !Array.isArray(value.tasks)) return false;
  const identity = value.identity;
  if (!exact(identity, ["requested", "effective"]) || identity.requested !== value.route || identity.effective !== value.route) return false;
  if (!exact(value.readiness, ["kind", "receipt"]) || value.readiness.kind !== "verified-provider" || !text(value.readiness.receipt)) return false;
  if (!exactSet(value.tasks.map((task) => object(task) && typeof task.caseId === "string" ? task.caseId : ""), CASE_IDS)) return false;
  if (!value.tasks.every((task) => validTask(task, identity))) return false;
  return routeAverage(value.tasks, "with-skill") > routeAverage(value.tasks, "without-skill");
}

function validTask(value: unknown, routeIdentity: Record<string, unknown>): boolean {
  if (!exact(value, ["caseId", "arms"]) || !Array.isArray(value.arms)) return false;
  const arms = value.arms;
  const caseId = value.caseId;
  if (!text(caseId)) return false;
  if (!exactSet(arms.map((arm) => object(arm) && typeof arm.arm === "string" ? arm.arm : ""), ARMS)) return false;
  if (!arms.every((arm) => validArm(arm, caseId, routeIdentity))) return false;
  const [withoutSkill, withSkill] = ARMS.map((name) => arms.find((arm) => object(arm) && arm.arm === name) as Record<string, unknown>);
  return average(withSkill.trials as readonly Record<string, unknown>[]) >= average(withoutSkill.trials as readonly Record<string, unknown>[]);
}

function average(trials: readonly Record<string, unknown>[]): number {
  return trials.reduce((total, trial) => total + (trial.score as number), 0) / trials.length;
}

function routeAverage(tasks: readonly unknown[], arm: Arm): number {
  return average(tasks.flatMap((task) => {
    const arms = (task as Record<string, unknown>).arms as readonly Record<string, unknown>[];
    return (arms.find((entry) => entry.arm === arm)?.trials ?? []) as readonly Record<string, unknown>[];
  }));
}

function validArm(value: unknown, caseId: string, routeIdentity: Record<string, unknown>): boolean {
  if (!exact(value, ["arm", "trials"]) || !ARMS.includes(value.arm as Arm) || !Array.isArray(value.trials) || value.trials.length !== 3) return false;
  const trials = value.trials.map((trial) => object(trial) && typeof trial.trial === "number" ? trial.trial : 0);
  if (!exactSet(trials.map(String), ["1", "2", "3"])) return false;
  const expected = value.arm === "with-skill" && NATIVE_SKILL_CHARACTERIZATION_CASES.find((entry) => entry.id === caseId)?.expected === "trigger";
  return value.trials.every((trial) => exact(trial, ["trial", "identity", "trigger", "outcome", "criticalInvariantPassed", "score"])
    && [1, 2, 3].includes(trial.trial as number)
    && exact(trial.identity, ["requested", "effective"])
    && trial.identity.requested === routeIdentity.requested && trial.identity.effective === routeIdentity.effective
    && trial.trigger === expected && trial.outcome === "passed" && trial.criticalInvariantPassed === true
    && typeof trial.score === "number" && Number.isFinite(trial.score) && trial.score >= 0 && trial.score <= 1);
}

export class SkillLifecycleService {
  evaluateChange(input: unknown): LifecycleDecision {
    if (!completeEvidence(input)) return { allowed: false, code: "input_invalid" };
    if (!input.ownerApproval) return { allowed: false, code: "owner_approval_missing" };
    if (input.referenceMigration !== "complete") return { allowed: false, code: "reference_migration_incomplete" };
    if (input.change === "alias-removal") return { allowed: false, code: "alias_removal_requires_gate" };
    if (input.change === "retirement") return { allowed: false, code: "retirement_unavailable" };
    return { allowed: false, code: "provider_evidence_unverified" };
  }

  mayRemove(input: unknown): LifecycleDecision {
    if (!completeEvidence(input)) return { allowed: false, code: "input_invalid" };
    if (input.change !== "alias-removal") return { allowed: false, code: "alias_removal_requires_gate" };
    if (!input.ownerApproval || !input.aliasRemovalApproval) return { allowed: false, code: "owner_approval_missing" };
    if (input.referenceMigration !== "complete") return { allowed: false, code: "reference_migration_incomplete" };
    return { allowed: false, code: "provider_evidence_unverified" };
  }

  mayRetire(input: unknown): LifecycleDecision {
    if (!completeEvidence(input)) return { allowed: false, code: "input_invalid" };
    if (input.change !== "retirement") return { allowed: false, code: "retirement_unavailable" };
    return { allowed: false, code: "retirement_unavailable" };
  }
}

export const evaluateSkillLifecycleChange = (input: unknown): LifecycleDecision => new SkillLifecycleService().evaluateChange(input);
