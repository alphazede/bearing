/**
 * CMD-HANDOFF-01 / SEIT-HANDOFF-01
 * Role return envelope validation and rejection of incomplete/stale returns.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const closeout = require(path.join(ROOT, "hooks", "closeout.cjs"));

export const HANDOFF_FIELDS = Object.freeze([
  "plan_ref",
  "role",
  "subject",
  "depends_on",
  "scope",
  "authority",
  "outcome",
  "evidence",
  "blocker",
  "next_action",
  "receiving_role",
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
  if (Array.isArray(handoff.depends_on)) {
    for (const dep of handoff.depends_on) {
      if (typeof dep !== "string" || !/^T[\w-]+$/.test(dep)) {
        diagnostics.push({
          code: "malformed_depends_on",
          message: `depends_on entry must be task_id, got ${JSON.stringify(dep)}`,
          field: "depends_on",
        });
      }
    }
  } else if (handoff.depends_on !== undefined && handoff.depends_on !== null) {
    // allow string "[]" style only if array; otherwise reject non-array lists of prose
    if (typeof handoff.depends_on === "string" && handoff.depends_on.trim() !== "[]") {
      // string form of empty list is not preferred; non-array with prose fails
      if (!/^\[\s*\]$/.test(handoff.depends_on.trim())) {
        diagnostics.push({
          code: "malformed_depends_on",
          message: "depends_on must be a task_id list",
          field: "depends_on",
        });
      }
    }
  }

  if (ctx.expectedSubject && handoff.subject !== ctx.expectedSubject) {
    diagnostics.push({
      code: "stale_subject",
      message: `subject "${String(handoff.subject)}" does not match expected "${ctx.expectedSubject}"`,
      field: "subject",
    });
  }

  const candidate =
    typeof handoff.candidate_ref === "string"
      ? handoff.candidate_ref
      : typeof handoff.subject === "string"
        ? null
        : null;
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
  // silence unused if subject-only path
  void candidate;

  if (diagnostics.length) {
    return { ok: false, action: "reroute", diagnostics };
  }
  return { ok: true, action: "advance" };
}

function validHandoff(overrides = {}) {
  return {
    plan_ref: "docs/plans/2026-08-09-bearing-skills-first-architecture",
    role: "crewmate",
    subject: "S8-packet-A",
    depends_on: [],
    scope: "test/*.test.mjs",
    authority: "slice S8 write set only",
    outcome: "PASS",
    evidence: "node --test exit 0",
    blocker: "none",
    next_action: "coordinator confirmation",
    receiving_role: "explorer",
    candidate_ref: "cand-abc",
    ...overrides,
  };
}

describe("CMD-HANDOFF-01 role-handoff (SEIT-HANDOFF-01)", () => {
  it("valid return requires all eleven fields and may advance", () => {
    const handoff = validHandoff();
    for (const field of HANDOFF_FIELDS) {
      assert.ok(field in handoff, field);
    }
    const verdict = validateHandoff(handoff, {
      expectedSubject: "S8-packet-A",
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
    delete handoff.evidence;
    const verdict = validateHandoff(handoff);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.equal(verdict.action, "reroute");
      assert.ok(
        verdict.diagnostics.some((d) => d.code === "missing_field" && d.field === "evidence")
      );
    }
  });

  it("negative: stale subject rejects/reroutes", () => {
    const verdict = validateHandoff(validHandoff({ subject: "S8-packet-OLD" }), {
      expectedSubject: "S8-packet-A",
    });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.equal(verdict.action, "reroute");
      assert.ok(verdict.diagnostics.some((d) => d.code === "stale_subject"));
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
