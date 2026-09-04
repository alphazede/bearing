/**
 * CMD-STATE-01 / SEIT-STATE-01
 * Declared states, legal transitions, owners; reject illegal/unowned/image authority.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TASK_STATE = readFileSync(
  path.join(ROOT, "skills/bearing-lite/references/task-state.md"),
  "utf8"
);
const require = createRequire(import.meta.url);
const transitionHook = require(path.join(ROOT, "hooks", "transition-order.cjs"));

/** Authoritative states from task-state.md table. */
export const DECLARED_STATES = Object.freeze([
  "PROPOSED",
  "READY",
  "WAITING_ON",
  "IN_PROGRESS",
  "EVIDENCE_READY",
  "VALIDATING",
  "REVIEWING",
  "ACCEPTANCE",
  "CORRECTION_REQUIRED",
  "OWNER_DECISION_REQUIRED",
  "COMPLETE",
  "CANCELLED",
]);

/** Active owners by state (from task-state.md). */
export const STATE_OWNERS = Object.freeze({
  PROPOSED: "Parent coordinator",
  READY: "Parent coordinator",
  WAITING_ON: "Parent coordinator",
  IN_PROGRESS: "Assigned worker or coordinator",
  EVIDENCE_READY: "Parent coordinator",
  VALIDATING: "Validator",
  REVIEWING: "Park Ranger when required",
  ACCEPTANCE:
    "Surveyor, Owner Authority, or parent coordinator when required_assurance is none",
  CORRECTION_REQUIRED: "Router or nearest parent coordinator",
  OWNER_DECISION_REQUIRED: "Owner Authority",
  COMPLETE: "Parent coordinator after assurance",
  CANCELLED: "Owner Authority or authorized parent",
});

/** Legal directed edges from authoritative text / transition hook. */
export const LEGAL_TRANSITIONS = Object.freeze({
  PROPOSED: ["READY", "WAITING_ON"],
  READY: ["IN_PROGRESS", "OWNER_DECISION_REQUIRED"],
  WAITING_ON: ["READY", "EVIDENCE_READY", "CANCELLED"],
  IN_PROGRESS: ["EVIDENCE_READY", "CORRECTION_REQUIRED", "OWNER_DECISION_REQUIRED"],
  EVIDENCE_READY: ["VALIDATING", "REVIEWING", "ACCEPTANCE", "WAITING_ON"],
  VALIDATING: ["EVIDENCE_READY", "CORRECTION_REQUIRED"],
  REVIEWING: ["EVIDENCE_READY", "CORRECTION_REQUIRED", "OWNER_DECISION_REQUIRED"],
  ACCEPTANCE: ["COMPLETE", "CORRECTION_REQUIRED"],
  CORRECTION_REQUIRED: ["READY", "OWNER_DECISION_REQUIRED"],
  OWNER_DECISION_REQUIRED: ["READY", "CANCELLED"],
  COMPLETE: [],
  CANCELLED: [],
});

/**
 * @typedef {{ code: string, message: string }} StateDiagnostic
 * @typedef {{ ok: true, from: string, to: string } | { ok: false, diagnostics: StateDiagnostic[] }} TransitionVerdict
 */

/**
 * @param {string} from
 * @param {string} to
 * @param {{
 *   owner?: string | null,
 *   skipAssurance?: boolean,
 *   imageDerivedAuthority?: boolean,
 *   requiredAssurance?: string[],
 *   assuranceCompleted?: string[],
 * }} [opts]
 * @returns {TransitionVerdict}
 */
export function validateTransition(from, to, opts = {}) {
  /** @type {StateDiagnostic[]} */
  const diagnostics = [];

  if (opts.imageDerivedAuthority === true) {
    diagnostics.push({
      code: "image_derived_authority",
      message: "diagrams explain but never authorize a transition or grant authority",
    });
  }

  if (!DECLARED_STATES.includes(from)) {
    diagnostics.push({ code: "unknown_from_state", message: `unknown from state ${from}` });
  }
  if (!DECLARED_STATES.includes(to)) {
    diagnostics.push({ code: "unknown_to_state", message: `unknown to state ${to}` });
  }

  const legal = LEGAL_TRANSITIONS[from] || [];
  if (!legal.includes(to)) {
    diagnostics.push({
      code: "unsupported_transition",
      message: `transition ${from} -> ${to} is not a legal edge`,
    });
  }

  if (opts.owner === null || opts.owner === "") {
    diagnostics.push({
      code: "unowned_transition",
      message: `transition ${from} -> ${to} has no active owner`,
    });
  }

  if (opts.skipAssurance === true && to === "COMPLETE") {
    diagnostics.push({
      code: "skipped_assurance",
      message: "cannot complete while required assurance is skipped",
    });
  }

  // Completing with open required assurance is a skipped assurance case.
  const required = opts.requiredAssurance ?? [];
  const completed = opts.assuranceCompleted ?? [];
  if (to === "COMPLETE" && required.some((r) => !completed.includes(r))) {
    diagnostics.push({
      code: "skipped_assurance",
      message: "required assurance still open at COMPLETE",
    });
  }

  if (diagnostics.length) return { ok: false, diagnostics };
  return { ok: true, from, to };
}

describe("CMD-STATE-01 task-state (SEIT-STATE-01)", () => {
  it("authoritative text declares every state with an active owner", () => {
    for (const state of DECLARED_STATES) {
      assert.match(TASK_STATE, new RegExp("`" + state + "`"));
      assert.ok(STATE_OWNERS[state], `owner for ${state}`);
      const ownerToken = STATE_OWNERS[state].split(/[\s,]+/).filter(Boolean)[0];
      assert.match(TASK_STATE, new RegExp(ownerToken));
    }
    assert.match(TASK_STATE, /Diagrams explain; they never authorize/i);
  });

  /**
   * Regression: product ACCEPTANCE active owner must preserve Surveyor and Owner
   * Authority and conditionally name parent coordinator only for
   * required_assurance: none (design.md / plan-spec written tables).
   * Fails until task-state.md ACCEPTANCE row is aligned.
   */
  it("ACCEPTANCE names parent coordinator only when required_assurance is none", () => {
    const row = TASK_STATE.match(/\|\s*`ACCEPTANCE`\s*\|\s*([^|\n]+)\|/);
    assert.ok(row, "ACCEPTANCE owner table row must exist");
    const ownerCell = row[1].trim();

    // Preserve independent-acceptance owners.
    assert.match(ownerCell, /Surveyor/);
    assert.match(ownerCell, /Owner Authority/);

    // Conditionally add parent coordinator for the none-assurance path only.
    assert.match(ownerCell, /parent coordinator/i);
    assert.match(
      ownerCell,
      /required_assurance[`'\s]*is[`'\s]*`?none`?|required_assurance:\s*none/i,
      "parent coordinator must be gated on required_assurance is none"
    );

    // Must not claim parent coordinator as the unconditional sole owner.
    assert.notEqual(
      ownerCell.replace(/`/g, "").trim().toLowerCase(),
      "parent coordinator"
    );

    // Fixture owner constant stays synchronized with the product table.
    assert.equal(STATE_OWNERS.ACCEPTANCE, ownerCell.replace(/`/g, "").trim());
  });

  it("covers every legal transition with owners", () => {
    let edgeCount = 0;
    for (const [from, targets] of Object.entries(LEGAL_TRANSITIONS)) {
      for (const to of targets) {
        edgeCount += 1;
        const verdict = validateTransition(from, to, {
          owner: STATE_OWNERS[from],
        });
        assert.equal(verdict.ok, true, `${from}->${to}: ${JSON.stringify(verdict)}`);
      }
    }
    assert.ok(edgeCount >= 20, `expected full edge coverage, got ${edgeCount}`);
  });

  it("transition-order hook LEGAL map matches authoritative legal edges", () => {
    assert.deepEqual(transitionHook.LEGAL, LEGAL_TRANSITIONS);
  });

  it("transition-order hook allows a legal edge and reroutes an illegal jump", () => {
    const allow = transitionHook.evaluate({
      from_state: "PROPOSED",
      to_state: "READY",
      prerequisites_met: true,
    });
    assert.equal(allow.outcome, "ADVISE");

    const illegal = transitionHook.evaluate({
      from_state: "PROPOSED",
      to_state: "COMPLETE",
      prerequisites_met: true,
    });
    assert.equal(illegal.outcome, "REROUTE");
    assert.match(String(illegal.reason), /illegal_transition/);
  });

  it("negative: skipped assurance is rejected", () => {
    const verdict = validateTransition("ACCEPTANCE", "COMPLETE", {
      owner: STATE_OWNERS.ACCEPTANCE,
      skipAssurance: true,
      requiredAssurance: ["Validator"],
      assuranceCompleted: [],
    });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.ok(verdict.diagnostics.some((d) => d.code === "skipped_assurance"));
    }
  });

  it("negative: unowned transition is rejected", () => {
    const verdict = validateTransition("READY", "IN_PROGRESS", { owner: null });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.ok(verdict.diagnostics.some((d) => d.code === "unowned_transition"));
    }
  });

  it("negative: unsupported/skipped transition is rejected", () => {
    const verdict = validateTransition("PROPOSED", "COMPLETE", {
      owner: STATE_OWNERS.PROPOSED,
    });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.ok(verdict.diagnostics.some((d) => d.code === "unsupported_transition"));
    }
  });

  it("negative: image-derived authority is rejected", () => {
    const verdict = validateTransition("READY", "IN_PROGRESS", {
      owner: STATE_OWNERS.READY,
      imageDerivedAuthority: true,
    });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.ok(verdict.diagnostics.some((d) => d.code === "image_derived_authority"));
    }
  });
});
