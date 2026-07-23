import { describe, expect, it } from "vitest";
import {
  NATIVE_SKILL_CHARACTERIZATION_CASES,
  SKILL_CHARACTERIZATION_MANIFEST,
  SKILL_NAMES,
  SkillLifecycleService,
} from "../src/skills/skill-lifecycle.js";
import { BUILTIN_ROUTES } from "../src/adapters/adapters.js";

const service = new SkillLifecycleService();
const routes = BUILTIN_ROUTES.map(({ id }) => id);
const fingerprints = [
  ["28e968fbb532c464f6d146d4f897c95b03c24d6d54cf10b799da538073f4198e", 14],
  ["9c1be46f8e895fc88eceb178d4f8f019127986d2aac9c723c592dadf37d95774", 16],
  ["5771ab35c2138fac7d9366e24be1acc70730881863dd367e777ad8799c310da8", 23],
  ["8a8361798f04711171e8c66c7bbec96fabc0100f17f9284d8b43a5dd601833a1", 18],
  ["26f5af019252490ddd49676e7e9acecfe8651be620470222ad598f8e77ca7600", 18],
  ["c1f0064032ca68876e936233be56a1ea8dfc1af9eea01e93c82a451303307b94", 18],
  ["15d01c6a7bb5b7f1236fb106eb70d7be9d47e67577a22e34009f8f9ff1d4a023", 16],
];

function evidence(change: "rename" | "content-optimization" | "alias-removal" | "retirement" = "rename") {
  return {
    schemaVersion: 1,
    change,
    ownerApproval: true,
    aliasRemovalApproval: true,
    referenceMigration: "complete",
    routes: routes.map((route) => ({
      route,
      identity: { requested: route, effective: route },
      readiness: { kind: "verified-provider", receipt: `readiness:${route}` },
      tasks: NATIVE_SKILL_CHARACTERIZATION_CASES.map((entry) => ({
        caseId: entry.id,
        arms: ["without-skill", "with-skill"].map((arm) => ({
          arm,
          trials: [1, 2, 3].map((trial) => ({
            trial,
            identity: { requested: route, effective: route },
            trigger: arm === "with-skill" && entry.expected === "trigger",
            outcome: "passed",
            criticalInvariantPassed: true,
            score: arm === "with-skill" && entry.kind === "positive" ? 0.6 : 0.4,
          })),
        })),
      })),
    })),
  };
}

function inherit(value: Record<string, unknown>, key: string): void {
  const inherited = value[key];
  delete value[key];
  Object.setPrototypeOf(value, { [key]: inherited });
  value.padding = true;
}

describe("skill characterization manifest", () => {
  it("pins all seven sources and exactly one positive and negative outcome case per skill", () => {
    expect(SKILL_CHARACTERIZATION_MANIFEST.schemaVersion).toBe(1);
    expect(SKILL_CHARACTERIZATION_MANIFEST.skills.map(({ name }) => name)).toEqual(SKILL_NAMES);
    expect(SKILL_CHARACTERIZATION_MANIFEST.skills.map(({ source }) => [source.sha256, source.lines])).toEqual(fingerprints);
    expect(SKILL_CHARACTERIZATION_MANIFEST.skills.every(({ directives, noOp, source, humanReview, changeStatus, compatibility, retirement }) => Object.values(directives).every(Boolean) && noOp === "none found" && source.lines < 500 && humanReview === "pending" && changeStatus === "unchanged" && compatibility === "canonical-only" && retirement === "not-eligible")).toBe(true);
    expect(NATIVE_SKILL_CHARACTERIZATION_CASES).toHaveLength(14);
    for (const skill of SKILL_NAMES) expect(NATIVE_SKILL_CHARACTERIZATION_CASES.filter((entry) => entry.skill === skill).map(({ kind }) => kind)).toEqual(["positive", "negative"]);
  });

  it("keeps directives body-free and classifies no-op current sources", () => {
    for (const entry of SKILL_CHARACTERIZATION_MANIFEST.skills) {
      expect(entry.classification).toBe("preference");
      expect(JSON.stringify(entry)).not.toContain("# ");
      expect(entry.changeStatus).toBe("unchanged");
    }
  });
});

describe("SkillLifecycleService", () => {
  it("rejects a rename when no evaluation evidence exists", () => {
    expect(service.evaluateChange({ schemaVersion: 1, change: "rename", ownerApproval: true, aliasRemovalApproval: false, referenceMigration: "complete", routes: [] })).toEqual({ allowed: false, code: "input_invalid" });
  });

  it("rejects inherited required fields at top-level and nested evidence shapes", () => {
    const topLevel = evidence();
    inherit(topLevel as unknown as Record<string, unknown>, "schemaVersion");
    expect(service.evaluateChange(topLevel)).toEqual({ allowed: false, code: "input_invalid" });
    const route = evidence();
    inherit(route.routes[0] as unknown as Record<string, unknown>, "route");
    expect(service.evaluateChange(route)).toEqual({ allowed: false, code: "input_invalid" });
    const task = evidence();
    inherit(task.routes[0].tasks[0] as unknown as Record<string, unknown>, "caseId");
    expect(service.evaluateChange(task)).toEqual({ allowed: false, code: "input_invalid" });
    const trial = evidence();
    inherit(trial.routes[0].tasks[0].arms[0].trials[0] as unknown as Record<string, unknown>, "trial");
    expect(service.evaluateChange(trial)).toEqual({ allowed: false, code: "input_invalid" });
  });

  it("retains aliases until reference migration and separate approval are complete", () => {
    const incomplete = evidence("alias-removal");
    incomplete.referenceMigration = "incomplete";
    expect(service.mayRemove(incomplete)).toEqual({ allowed: false, code: "reference_migration_incomplete" });
    incomplete.referenceMigration = "complete";
    incomplete.aliasRemovalApproval = false;
    expect(service.mayRemove(incomplete)).toEqual({ allowed: false, code: "owner_approval_missing" });
    expect(service.mayRemove(evidence("alias-removal"))).toEqual({ allowed: false, code: "provider_evidence_unverified" });
  });

  it("accepts negative ties but rejects a case regression and zero-uplift route", () => {
    expect(service.evaluateChange(evidence())).toEqual({ allowed: false, code: "provider_evidence_unverified" });
    const regression = evidence();
    regression.routes[0].tasks[0].arms[1].trials.forEach((trial) => { trial.score = 0.3; });
    expect(service.evaluateChange(regression)).toEqual({ allowed: false, code: "input_invalid" });
    const maskedRoute = evidence();
    maskedRoute.routes[1].tasks.forEach((task) => task.arms[1].trials.forEach((trial) => { trial.score = 0.4; }));
    expect(service.evaluateChange(maskedRoute)).toEqual({ allowed: false, code: "input_invalid" });
  });

  it("fails closed for missing or duplicate cells, identity drift, and out-of-range scores", () => {
    const missingTrial = evidence();
    missingTrial.routes[0].tasks[0].arms[0].trials.pop();
    expect(service.evaluateChange(missingTrial)).toEqual({ allowed: false, code: "input_invalid" });
    const duplicateTrial = evidence();
    duplicateTrial.routes[0].tasks[0].arms[0].trials[2].trial = 2;
    expect(service.evaluateChange(duplicateTrial)).toEqual({ allowed: false, code: "input_invalid" });
    const drift = evidence();
    drift.routes[0].identity.effective = "substituted";
    expect(service.evaluateChange(drift)).toEqual({ allowed: false, code: "input_invalid" });
    for (const score of [-0.1, 1.1, Infinity]) {
      const invalidScore = evidence();
      invalidScore.routes[0].tasks[0].arms[0].trials[0].score = score;
      expect(service.evaluateChange(invalidScore)).toEqual({ allowed: false, code: "input_invalid" });
    }
  });

  it("fails closed for wrong arm triggers and lifecycle method changes", () => {
    const wrongArm = evidence();
    wrongArm.routes[0].tasks[0].arms[0].trials[0].trigger = true;
    expect(service.evaluateChange(wrongArm)).toEqual({ allowed: false, code: "input_invalid" });
    expect(service.evaluateChange(evidence("alias-removal"))).toEqual({ allowed: false, code: "alias_removal_requires_gate" });
    expect(service.mayRemove(evidence())).toEqual({ allowed: false, code: "alias_removal_requires_gate" });
    expect(service.mayRetire(evidence())).toEqual({ allowed: false, code: "retirement_unavailable" });
  });

  it("refuses synthetic or empty provider readiness evidence", () => {
    const synthetic = evidence();
    synthetic.routes[0].readiness.kind = "synthetic";
    expect(service.evaluateChange(synthetic)).toEqual({ allowed: false, code: "input_invalid" });
    expect(service.mayRemove({ ...synthetic, change: "alias-removal" })).toEqual({ allowed: false, code: "input_invalid" });
    const empty = evidence();
    empty.routes[0].readiness.receipt = "";
    expect(service.evaluateChange(empty)).toEqual({ allowed: false, code: "input_invalid" });
    const oldRouteSpelling = evidence();
    oldRouteSpelling.routes[3].route = "pi-deepseek-v4-pro";
    oldRouteSpelling.routes[3].identity = { requested: "pi-deepseek-v4-pro", effective: "pi-deepseek-v4-pro" };
    expect(service.evaluateChange(oldRouteSpelling)).toEqual({ allowed: false, code: "input_invalid" });
  });

  it("never authorizes fabricated provider evidence in this slice", () => {
    expect(service.evaluateChange(evidence())).toEqual({ allowed: false, code: "provider_evidence_unverified" });
    expect(service.evaluateChange(evidence("content-optimization"))).toEqual({ allowed: false, code: "provider_evidence_unverified" });
    expect(service.mayRemove(evidence("alias-removal"))).toEqual({ allowed: false, code: "provider_evidence_unverified" });
    expect(service.mayRetire(evidence("retirement"))).toEqual({ allowed: false, code: "retirement_unavailable" });
  });
});
