import { BUILTIN_ROUTES } from "../adapters/adapters.js";

export const SKILL_LIFECYCLE_SCHEMA_VERSION = 1 as const;

export const SKILL_NAMES = [
  "to-plan", "grill-with-docs", "design-driven-build", "ultimate-loop",
  "conductor-orchestrate", "implementer", "gate-review",
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

/** Pinned, body-free characterization of the seven read-only canonical sources. */
export const SKILL_CHARACTERIZATION_MANIFEST = {
  schemaVersion: SKILL_LIFECYCLE_SCHEMA_VERSION,
  skills: [
    characterization("to-plan", "Set Bearings", "Durable plan-artifact and handoff policy.", "Start a plan directory.", "A user starts or resumes planning.", "Create the stub and print the next handoff.", "Do not trigger for a tentative planning discussion.", "3b3de6336b48901e5e16c5d74546526d5cadd2d1dd8225def75ca44ac049d860", 111),
    characterization("grill-with-docs", "Gather Supplies", "Durable source and owner-decision policy for specifications.", "Harden a plan specification.", "Explicit invocation or a to-plan handoff has a stub.", "Map sources, resolve decisions, and write the spec.", "Do not trigger for a request to merely summarize documentation.", "2828987ba022e151dedfcf41d97e71968657121136d0681ad4b4ed8dd1289070", 143),
    characterization("design-driven-build", "Map the Route", "Durable design, SEIT, and OOPDSA policy.", "Design an approved plan.", "The owner explicitly asks for feature design.", "Select lenses, write design and SEIT, then hand off.", "Do not trigger for a request to implement an existing design.", "332fa54e79f29fcfbc5b362ff482e2e10fcdfee7363dbdcd85f84e7d1f436076", 84),
    characterization("ultimate-loop", "Navigator", "Durable multi-wave execution and authority policy.", "Run dependent implementation waves.", "The owner explicitly invokes the loop over complete plan artifacts.", "Retain phase conductors and independently gate integrated work.", "Do not trigger for one bounded task with no waves.", "a430306340804ca96388cd8774f395ca58759fe80dd0f4129995cb5ad1834d6c", 106),
    characterization("conductor-orchestrate", "Explorer", "Durable bounded-execution and validation policy.", "Complete isolated implementer work.", "A bounded owner packet needs execution and validation.", "Dispatch bounded work, inspect diffs, and validate.", "Do not trigger for a task that needs approved multi-wave orchestration.", "ad68a5484916747c10169aa0ac4aeec97901c77ca82ce0d0a6d03988a7e9e872", 148),
    characterization("implementer", "Crewmate", "Durable implementation-role and scope policy.", "Make the approved change.", "An implementer receives a settled bounded coding packet.", "Edit only allowed paths and return validation evidence.", "Do not trigger for an unresolved design decision.", "9712c1fa88579be67d004c61f5e6e62f4ddc9d3ab25f459d6a2355058f324069", 47),
    characterization("gate-review", "Surveyor", "Durable independent-review and closure policy.", "Certify completed gated work.", "Completed implementation reaches a gated surface.", "Prepare one packet, review once, and close verified findings.", "Do not trigger for a documentation-only workflow edit.", "d4bcd3358d6f326fad96a2e9cf680638f783800c6ea8c3d3cb71bc8c177a8727", 149),
  ] as const,
} as const;

const cases = (skill: SkillName, positive: string, negative: string, invariant: string): readonly TriggerCase[] => [
  { id: `${skill}:positive`, skill, kind: "positive", prompt: positive, expected: "trigger", invariant },
  { id: `${skill}:negative`, skill, kind: "negative", prompt: negative, expected: "do-not-trigger", invariant },
];

/** Exactly one outcome-graded positive and negative case for every skill. */
export const NATIVE_SKILL_CHARACTERIZATION_CASES = [
  ...cases("to-plan", "Create a plan for adding account export.", "We should eventually plan account export.", "prints a handoff without drafting downstream artifacts"),
  ...cases("grill-with-docs", "Use grill-with-docs on the account-export plan stub.", "Summarize the account-export docs for me.", "does not resolve owner decisions from evidence"),
  ...cases("design-driven-build", "Use design-driven-build on this approved account-export plan.", "Implement the approved account-export design.", "does not write implementation slices"),
  ...cases("ultimate-loop", "Use ultimate-loop to execute the approved multi-wave account-export plan.", "Implement this one bounded account-export test fix.", "does not use a Fellow for a standalone task"),
  ...cases("conductor-orchestrate", "Complete this bounded account-export packet with its named tests.", "Coordinate a multi-wave account-export program with independent gates.", "does not expand the packet authority"),
  ...cases("implementer", "Implement the approved account-export packet in its allowed paths.", "Choose the account-export architecture before coding.", "does not edit outside allowed paths"),
  ...cases("gate-review", "Review the completed account-export implementation against its gate packet.", "Edit the account-export documentation wording only.", "does not let the implementer self-certify"),
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
