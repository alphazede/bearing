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
  "Router", "Navigator", "Trail Boss", "Explorer", "Sub-Explorer",
  "Crewmate", "Validator", "Park Ranger", "Surveyor",
];

describe("Journey defaults", () => {
  it("offers exactly the owner-selected review boundaries", () => {
    assert.match(CONFIG, /review_cadence: <per-slice \| per-round \| at-end>/);
    assert.doesNotMatch(CONFIG, /once-at-end|per-phase|review_cadence:\s*none/);
  });

  it("requires primary and fallback identity, model, and reasoning for every role", () => {
    for (const role of ROLES) {
      assert.match(CONFIG, new RegExp(`\\| ${role.replace("-", "\\-")} \\|`));
    }
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
});
