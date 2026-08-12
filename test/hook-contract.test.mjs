/**
 * CMD-HOOK-01 / SEIT-HOOK-CLASS-01, SEIT-HOOK-COVERAGE-01
 * Exactly four hook classes; outcomes ADVISE|REROUTE|BLOCK|UNAVAILABLE; coverage honesty.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS_DIR = path.join(ROOT, "hooks");
const require = createRequire(import.meta.url);

const EXPECTED_CLASSES = new Set([
  "activation",
  "closeout",
  "transition",
  "protected_action",
]);
const ALLOWED_OUTCOMES = new Set(["ADVISE", "REROUTE", "BLOCK", "UNAVAILABLE"]);

const activation = require(path.join(HOOKS_DIR, "activation.cjs"));
const closeout = require(path.join(HOOKS_DIR, "closeout.cjs"));
const transition = require(path.join(HOOKS_DIR, "transition-order.cjs"));
const protectedAction = require(path.join(HOOKS_DIR, "protected-action.cjs"));

const HOOKS = [
  { file: "activation.cjs", mod: activation, className: "activation" },
  { file: "closeout.cjs", mod: closeout, className: "closeout" },
  { file: "transition-order.cjs", mod: transition, className: "transition" },
  { file: "protected-action.cjs", mod: protectedAction, className: "protected_action" },
];

/**
 * Client capability coverage model.
 * @param {'full'|'partial'|'skills-only'} client
 * @param {{ claimExecutable?: string[] }} [opts]
 */
export function reportHookCoverage(client, opts = {}) {
  /** @type {Record<string, { executable: boolean, procedural: boolean }>} */
  const coverage = {};
  for (const cls of EXPECTED_CLASSES) {
    if (client === "full") {
      coverage[cls] = { executable: true, procedural: true };
    } else if (client === "partial") {
      // Partial: activation+closeout executable; transition+protected procedural only.
      const exec = cls === "activation" || cls === "closeout";
      coverage[cls] = { executable: exec, procedural: true };
    } else {
      coverage[cls] = { executable: false, procedural: true };
    }
  }
  /** @type {{ code: string, message: string }[]} */
  const diagnostics = [];
  for (const claimed of opts.claimExecutable || []) {
    if (!coverage[claimed]?.executable) {
      diagnostics.push({
        code: "unsupported_class_claimed_executable",
        message: `client ${client} cannot claim class "${claimed}" as executable enforcement`,
      });
    }
  }
  if (diagnostics.length) {
    return { ok: false, client, coverage, diagnostics };
  }
  return { ok: true, client, coverage, diagnostics: [] };
}

describe("CMD-HOOK-01 hook-contract (SEIT-HOOK-CLASS-01, SEIT-HOOK-COVERAGE-01)", () => {
  it("ships exactly four hook class modules under hooks/", () => {
    const files = readdirSync(HOOKS_DIR).filter((f) => f.endsWith(".cjs")).sort();
    assert.deepEqual(files, [
      "activation.cjs",
      "closeout.cjs",
      "protected-action.cjs",
      "transition-order.cjs",
    ]);
    const classes = new Set(HOOKS.map((h) => h.mod.HOOK_CLASS));
    assert.deepEqual([...classes].sort(), [...EXPECTED_CLASSES].sort());
    assert.equal(classes.size, 4);
  });

  it("each hook exports evaluate() and OUTCOMES limited to ADVISE|REROUTE|BLOCK|UNAVAILABLE", () => {
    for (const h of HOOKS) {
      assert.equal(typeof h.mod.evaluate, "function", h.file);
      assert.ok(Array.isArray(h.mod.OUTCOMES) || h.mod.OUTCOMES instanceof Array);
      for (const o of h.mod.OUTCOMES) {
        assert.ok(ALLOWED_OUTCOMES.has(o), `${h.file} unexpected outcome ${o}`);
      }
      assert.equal(h.mod.HOOK_CLASS, h.className);
    }
  });

  it("activation is advisory (ADVISE) and never fabricates BLOCK for incomplete context", () => {
    const incomplete = activation.evaluate({
      plan_present: false,
      router_invoked: false,
    });
    assert.equal(incomplete.hook_class, "activation");
    assert.equal(incomplete.outcome, "ADVISE");
    assert.notEqual(incomplete.outcome, "BLOCK");

    const ready = activation.evaluate({
      plan_present: true,
      next_action_known: true,
      assigned_role: "crewmate",
      router_invoked: true,
      missing_planning_stages: [],
    });
    assert.equal(ready.outcome, "ADVISE");
    assert.match(String(ready.reason), /context_ready/);
  });

  it("closeout advisory vs narrow BLOCK for protected completion", () => {
    const handoff = {
      plan_ref: "plan",
      role: "crewmate",
      subject: "S8",
      depends_on: [],
      scope: "test/",
      authority: "S8",
      outcome: "PASS",
      evidence: "ok",
      blocker: "none",
      next_action: "confirm",
      receiving_role: "explorer",
    };
    const advisory = closeout.evaluate({
      handoff,
      required_assurance: "none",
      assurance_accepted: [],
      candidate_matched: true,
    });
    assert.equal(advisory.outcome, "ADVISE");

    const blocked = closeout.evaluate({
      mode: "protected_completion",
      handoff,
      required_assurance: ["Validator"],
      assurance_accepted: [],
      candidate_matched: false,
    });
    assert.equal(blocked.outcome, "BLOCK");
    assert.match(String(blocked.reason), /protected_completion_invalid/);
  });

  it("transition reroutes illegal edges; BLOCKs only narrow sequence violations", () => {
    const reroute = transition.evaluate({
      from_state: "IN_PROGRESS",
      to_state: "COMPLETE",
      prerequisites_met: true,
    });
    assert.equal(reroute.outcome, "REROUTE");

    const hard = transition.evaluate({
      from_state: "ACCEPTANCE",
      to_state: "COMPLETE",
      prerequisites_met: true,
      skip_required_step: true,
      after_reroute: true,
      required_assurance: ["Validator"],
      assurance_completed: [],
    });
    assert.equal(hard.outcome, "BLOCK");
  });

  it("protected_action BLOCKs explicit violations; safe channels remain open", () => {
    const clear = protectedAction.evaluate({ protected_action: "publish", owner_authorized: true });
    assert.equal(clear.outcome, "ADVISE");

    const secret = protectedAction.evaluate({
      protected_action: "export",
      secret_exposure: true,
    });
    assert.equal(secret.outcome, "BLOCK");

    for (const channel of ["repair", "status", "owner_communication", "safe_rollback"]) {
      const open = protectedAction.evaluate({ channel });
      assert.equal(open.outcome, "ADVISE", channel);
      assert.match(String(open.reason), /channel_open/);
    }
  });

  it("client capability fixtures: full / partial / skills-only report honest coverage", () => {
    const full = reportHookCoverage("full");
    assert.equal(full.ok, true);
    for (const cls of EXPECTED_CLASSES) {
      assert.equal(full.coverage[cls].executable, true);
    }

    const partial = reportHookCoverage("partial");
    assert.equal(partial.ok, true);
    assert.equal(partial.coverage.activation.executable, true);
    assert.equal(partial.coverage.transition.executable, false);
    assert.equal(partial.coverage.transition.procedural, true);

    const skillsOnly = reportHookCoverage("skills-only");
    assert.equal(skillsOnly.ok, true);
    for (const cls of EXPECTED_CLASSES) {
      assert.equal(skillsOnly.coverage[cls].executable, false);
      assert.equal(skillsOnly.coverage[cls].procedural, true);
    }
  });

  it("negative: claiming unsupported class as executable enforcement fails", () => {
    const verdict = reportHookCoverage("skills-only", {
      claimExecutable: ["protected_action", "transition"],
    });
    assert.equal(verdict.ok, false);
    assert.ok(
      verdict.diagnostics.some((d) => d.code === "unsupported_class_claimed_executable")
    );

    const partialBad = reportHookCoverage("partial", {
      claimExecutable: ["protected_action"],
    });
    assert.equal(partialBad.ok, false);
  });
});
