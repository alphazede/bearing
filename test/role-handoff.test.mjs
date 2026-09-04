/**
 * CMD-HANDOFF-01 / SEIT-HANDOFF-01
 * Role return envelope validation and rejection of incomplete/stale returns.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const closeout = require(path.join(ROOT, "hooks", "closeout.cjs"));

export const HANDOFF_FIELDS = Object.freeze([
  "outcome",
  "candidate_ref",
  "changed_paths",
  "tests",
  "findings",
  "blocker",
]);

/**
 * @typedef {{ code: string, message: string, field?: string }} HandoffDiagnostic
 * @typedef {{ ok: true, action: 'advance' } | { ok: false, action: 'reroute', diagnostics: HandoffDiagnostic[] }} HandoffVerdict
 */

/**
 * Validate a role return handoff against CONTRACT-HANDOFF-01.
 * @param {Record<string, unknown>} handoff
 * @param {{ expectedSubject?: string, expectedCandidate?: string, planCandidate?: string }} [ctx]
 * @returns {HandoffVerdict}
 */
export function validateHandoff(handoff, ctx = {}) {
  /** @type {HandoffDiagnostic[]} */
  const diagnostics = [];
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) {
    return {
      ok: false,
      action: "reroute",
      diagnostics: [{ code: "handoff_not_object", message: "handoff must be an object" }],
    };
  }
  for (const field of HANDOFF_FIELDS) {
    const value = handoff[field];
    if (value === undefined || value === null) {
      diagnostics.push({
        code: "missing_field",
        message: `required handoff field "${field}" is missing`,
        field,
      });
      continue;
    }
    if (typeof value === "string" && value.trim() === "") {
      diagnostics.push({
        code: "missing_field",
        message: `required handoff field "${field}" is empty`,
        field,
      });
    }
  }
  const narrativeOnly =
    ["plan_ref", "role", "subject", "depends_on", "scope", "authority", "evidence", "next_action", "receiving_role"].some(
      (field) => handoff[field] !== undefined && handoff[field] !== null && String(handoff[field]).trim() !== ""
    ) &&
    HANDOFF_FIELDS.every((field) => {
      const value = handoff[field];
      return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
    });
  if (narrativeOnly) {
    diagnostics.push({
      code: "narrative_only_handoff",
      message: "narrative-only handoffs are rejected; return the six-field compact receipt",
    });
  }

  if (ctx.expectedCandidate) {
    const provided =
      typeof handoff.candidate_ref === "string" ? handoff.candidate_ref : ctx.planCandidate;
    if (provided !== ctx.expectedCandidate) {
      diagnostics.push({
        code: "candidate_mismatch",
        message: `candidate_ref "${String(provided)}" does not match expected "${ctx.expectedCandidate}"`,
        field: "candidate_ref",
      });
    }
  }
  if (diagnostics.length) {
    return { ok: false, action: "reroute", diagnostics };
  }
  return { ok: true, action: "advance" };
}

function validHandoff(overrides = {}) {
  return {
    outcome: "PASS",
    candidate_ref: "cand-abc",
    changed_paths: ["test/role-handoff.test.mjs"],
    tests: "node --test exit 0",
    findings: "none",
    blocker: "none",
    ...overrides,
  };
}

describe("CMD-HANDOFF-01 role-handoff (SEIT-HANDOFF-01)", () => {
  it("valid return requires the six-field compact receipt and may advance", () => {
    const handoff = validHandoff();
    for (const field of HANDOFF_FIELDS) {
      assert.ok(field in handoff, field);
    }
    const verdict = validateHandoff(handoff, {
      expectedCandidate: "cand-abc",
    });
    assert.equal(verdict.ok, true);
    if (verdict.ok) assert.equal(verdict.action, "advance");
  });

  it("closeout hook agrees on complete advisory handoff", () => {
    const handoff = validHandoff();
    const result = closeout.evaluate({
      handoff,
      required_assurance: "none",
      assurance_accepted: [],
      candidate_matched: true,
      blocker: "none",
    });
    assert.equal(result.hook_class, "closeout");
    assert.equal(result.outcome, "ADVISE");
  });

  it("negative: missing field reroutes with typed diagnostic (not silent advance)", () => {
    const handoff = validHandoff();
    delete handoff.findings;
    const verdict = validateHandoff(handoff);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.equal(verdict.action, "reroute");
      assert.ok(
        verdict.diagnostics.some((d) => d.code === "missing_field" && d.field === "findings")
      );
    }
  });

  it("negative: narrative-only handoff rejects/reroutes", () => {
    const verdict = validateHandoff({
      plan_ref: "plan",
      role: "crewmate",
      subject: "S8-packet-A",
      depends_on: [],
      scope: "test/",
      authority: "S8",
      evidence: "long narrative",
      next_action: "continue",
      receiving_role: "explorer",
    });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.equal(verdict.action, "reroute");
      assert.ok(verdict.diagnostics.some((d) => d.code === "narrative_only_handoff"));
    }
  });

  it("negative: candidate mismatch rejects/reroutes", () => {
    const verdict = validateHandoff(validHandoff({ candidate_ref: "cand-stale" }), {
      expectedCandidate: "cand-abc",
    });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.equal(verdict.action, "reroute");
      assert.ok(verdict.diagnostics.some((d) => d.code === "candidate_mismatch"));
    }
  });

  it("Direct and Expedition bound exhaustion name candidate and count", () => {
    const router = readFileSync(
      path.join(ROOT, "skills/bearing-lite/SKILL.md"),
      "utf8"
    );
    const explorer = readFileSync(
      path.join(ROOT, "skills/explorer/SKILL.md"),
      "utf8"
    );
    assert.match(router, /Direct route/);
    assert.match(router, /OWNER_DECISION_REQUIRED` naming the candidate and count/);
    assert.match(explorer, /OWNER_DECISION_REQUIRED` with\s+candidate and count/);
    assert.doesNotMatch(
      router,
      /only when Navigator|requires Navigator to bound|inherited from Bearing's Navigator/i
    );
  });

  it("closeout protected completion BLOCKs on candidate mismatch", () => {
    const result = closeout.evaluate({
      mode: "protected_completion",
      handoff: validHandoff(),
      required_assurance: [],
      assurance_accepted: [],
      candidate_matched: false,
      blocker: "none",
    });
    assert.equal(result.outcome, "BLOCK");
    assert.match(String(result.reason), /candidate_mismatch/);
  });
});
