import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = readFileSync(
  path.join(ROOT, "skills/bearing-lite/templates/default-role-lineup.md"),
  "utf8"
);

const ROLES = [
  "Router", "Explorer",
  "Crewmate", "Validator", "Park Ranger", "Surveyor",
];

describe("Journey defaults", () => {
  it("records at-end review only", () => {
    assert.match(CONFIG, /review_cadence:\s*at-end/);
    assert.doesNotMatch(CONFIG, /per-slice|per-round|per-phase|review_cadence:\s*none/);
    assert.match(CONFIG, /Navigator is not a normal lineup role/);
  });

  it("requires primary and fallback identity, model, and reasoning for every role", () => {
    for (const role of ROLES) {
      assert.match(CONFIG, new RegExp(`\\| ${role.replace("-", "\\-")} \\|`));
    }
    assert.doesNotMatch(CONFIG, /Trail Boss|Sub-Explorer|trail-boss|sub-explorer/);
    assert.match(CONFIG, /Primary agent\/harness/);
    assert.match(CONFIG, /Fallback agent\/harness/);
    assert.match(CONFIG, /Primary reasoning/);
    assert.match(CONFIG, /Fallback reasoning/);
    assert.match(CONFIG, /Never fill\s+agent, model, or reasoning values on the user's behalf/);
  });

  it("permits fallback only after verified primary unavailability", () => {
    assert.match(CONFIG, /Only verified primary unavailability activates/);
    assert.match(CONFIG, /OWNER_DECISION_REQUIRED/);
  });

  it("max_assurance_rounds is a fixed Lite rule, not an owner-selected budget", () => {
    const router = readFileSync(
      path.join(ROOT, "skills/bearing-lite/SKILL.md"),
      "utf8"
    );
    assert.match(router, /`max_assurance_rounds` is\s+1/);
    assert.doesNotMatch(CONFIG, /max_assurance_rounds|assurance_rounds/);
    assert.doesNotMatch(CONFIG, /assurance budget|review-round limit/i);
  });

  it("in-flight identities come from the Journey snapshot, not later global defaults", () => {
    const router = readFileSync(
      path.join(ROOT, "skills/bearing-lite/SKILL.md"),
      "utf8"
    );
    const task = readFileSync(
      path.join(ROOT, "skills/bearing-lite/templates/task.md"),
      "utf8"
    );
    assert.match(router, /recorded snapshot is authoritative for this Journey/);
    assert.match(
      router,
      /Later edits to\s+`~\/\.agents\/bearing-lite\/default-role-lineup\.md` have no effect on it/
    );
    assert.match(task, /lineup_snapshot:/i);
    assert.match(task, /explicit owner-confirmed dated visible amendment/);
    assert.match(CONFIG, /The Router displays it before\s+implementation/);
    assert.doesNotMatch(
      CONFIG,
      /overrides the recorded Journey snapshot|live override of an in-flight Journey/i
    );
  });
});
