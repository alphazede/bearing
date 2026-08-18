/**
 * CMD-RECOVERY-01 / SEIT-CORRECTION-01, SEIT-DEPENDENCY-01
 * Correction attempts, waiting isolation, dependency closure.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TASK_STATE = readFileSync(
  path.join(ROOT, "skills/bearing-lite/references/task-state.md"),
  "utf8"
);
const ROUTER = readFileSync(
  path.join(ROOT, "skills/bearing-lite/SKILL.md"),
  "utf8"
);

/**
 * @typedef {{
 *   taskId: string,
 *   attempts: number,
 *   lastHypothesis?: string,
 *   lastEvidence?: string,
 *   status: string,
 * }} CorrectionTask
 *
 * @typedef {{ ok: true, task: CorrectionTask } | { ok: false, code: string, message: string, task?: CorrectionTask }} CorrectionVerdict
 */

/**
 * Apply a correction attempt with new hypothesis/evidence policy.
 * Waiting does not consume attempts. Max 3 attempts → OWNER_DECISION_REQUIRED.
 * @param {CorrectionTask} task
 * @param {{ hypothesis?: string, evidence?: string, kind?: 'correct'|'wait' }} action
 * @returns {CorrectionVerdict}
 */
export function applyCorrection(task, action) {
  if (action.kind === "wait") {
    // Waiting does not consume attempts or change correction counter.
    return {
      ok: true,
      task: {
        ...task,
        status: "WAITING_ON",
      },
    };
  }

  const hypothesis = (action.hypothesis || "").trim();
  const evidence = (action.evidence || "").trim();
  if (!hypothesis || !evidence) {
    return {
      ok: false,
      code: "identical_retry_without_new_evidence",
      message: "correction requires a new hypothesis and evidence",
      task,
    };
  }
  if (
    hypothesis === task.lastHypothesis &&
    evidence === task.lastEvidence
  ) {
    return {
      ok: false,
      code: "identical_retry_without_new_evidence",
      message: "identical retry without new evidence is invalid",
      task,
    };
  }

  const nextAttempts = task.attempts + 1;
  if (nextAttempts > 3) {
    return {
      ok: false,
      code: "fourth_correction",
      message: "fourth correction attempt is rejected; owner decision already required",
      task: { ...task, status: "OWNER_DECISION_REQUIRED" },
    };
  }
  if (nextAttempts === 3) {
    // Third failed correction → OWNER_DECISION_REQUIRED
    return {
      ok: true,
      task: {
        ...task,
        attempts: nextAttempts,
        lastHypothesis: hypothesis,
        lastEvidence: evidence,
        status: "OWNER_DECISION_REQUIRED",
      },
    };
  }
  // Attempts 1 and 2: return to READY with new evidence.
  return {
    ok: true,
    task: {
      ...task,
      attempts: nextAttempts,
      lastHypothesis: hypothesis,
      lastEvidence: evidence,
      status: "READY",
    },
  };
}

/**
 * @typedef {{ id: string, dependsOn: string[], status: string }} GraphTask
 * @typedef {{
 *   waiting: string[],
 *   runnable: string[],
 *   stopped: string[],
 * } | { ok: false, code: string, message: string }} ClosureResult
 */

/**
 * Dependency closure: failed task pauses transitive dependents only.
 * @param {GraphTask[]} tasks
 * @param {string} failedId
 * @param {{ stopUnrelated?: boolean, allowDependentProceed?: boolean }} [opts]
 * @returns {ClosureResult | { ok: false, code: string, message: string }}
 */
export function dependencyClosure(tasks, failedId, opts = {}) {
  if (opts.allowDependentProceed === true) {
    return {
      ok: false,
      code: "dependent_proceeds",
      message: "dependent work must not proceed while a prerequisite has failed",
    };
  }
  if (opts.stopUnrelated === true) {
    return {
      ok: false,
      code: "unrelated_work_stopped_without_conflict",
      message: "unrelated independent work must remain ready without a conflict path",
    };
  }

  const byId = new Map(tasks.map((t) => [t.id, t]));
  if (!byId.has(failedId)) {
    return { ok: false, code: "unknown_failed_task", message: `unknown task ${failedId}` };
  }

  /** @type {Set<string>} */
  const paused = new Set([failedId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of tasks) {
      if (paused.has(t.id)) continue;
      if (t.dependsOn.some((d) => paused.has(d))) {
        paused.add(t.id);
        changed = true;
      }
    }
  }

  const waiting = [...paused].filter((id) => id !== failedId).sort();
  const runnable = tasks
    .filter((t) => !paused.has(t.id) && t.status !== "CANCELLED")
    .map((t) => t.id)
    .sort();
  const stopped = [failedId];

  return { waiting, runnable, stopped };
}

describe("CMD-RECOVERY-01 recovery (SEIT-CORRECTION-01, SEIT-DEPENDENCY-01)", () => {
  it("task-state records checkout-lease release and stale recovery", () => {
    assert.match(TASK_STATE, /Checkout lease/);
    assert.match(TASK_STATE, /generation-bound checkout lease/);
    assert.match(TASK_STATE, /checkout-lease conflict/);
    assert.match(TASK_STATE, /sanitized/);
    assert.match(TASK_STATE, /same generation/);
    assert.match(TASK_STATE, /exactly\s+once/);
    assert.match(TASK_STATE, /Stale recovery/);
    assert.match(TASK_STATE, /increments generation/);
    assert.match(TASK_STATE, /cannot\s+steal a live lease/);
    assert.match(TASK_STATE, /fail closed/);
    assert.match(ROUTER, /release the checkout lease exactly once/);
    assert.match(ROUTER, /explicit recorded generation increment/);
    assert.match(ROUTER, /cannot steal a live lease/);
  });

  it("correction attempts 1 and 2 require new evidence/hypothesis and return READY", () => {
    let task = {
      taskId: "T1",
      attempts: 0,
      status: "CORRECTION_REQUIRED",
    };
    const a1 = applyCorrection(task, {
      hypothesis: "missing assertion",
      evidence: "added failing test",
    });
    assert.equal(a1.ok, true);
    if (a1.ok) {
      assert.equal(a1.task.attempts, 1);
      assert.equal(a1.task.status, "READY");
      task = a1.task;
    }
    const a2 = applyCorrection(task, {
      hypothesis: "hook outcome wrong",
      evidence: "assert outcome === UNAVAILABLE",
    });
    assert.equal(a2.ok, true);
    if (a2.ok) {
      assert.equal(a2.task.attempts, 2);
      assert.equal(a2.task.status, "READY");
    }
  });

  it("third failed correction → OWNER_DECISION_REQUIRED", () => {
    const task = {
      taskId: "T1",
      attempts: 2,
      lastHypothesis: "h2",
      lastEvidence: "e2",
      status: "CORRECTION_REQUIRED",
    };
    const a3 = applyCorrection(task, {
      hypothesis: "h3",
      evidence: "e3",
    });
    assert.equal(a3.ok, true);
    if (a3.ok) {
      assert.equal(a3.task.attempts, 3);
      assert.equal(a3.task.status, "OWNER_DECISION_REQUIRED");
    }
  });

  it("waiting does not consume attempts; counters do not leak across tasks", () => {
    const t1 = {
      taskId: "T1",
      attempts: 1,
      lastHypothesis: "h1",
      lastEvidence: "e1",
      status: "CORRECTION_REQUIRED",
    };
    const waited = applyCorrection(t1, { kind: "wait" });
    assert.equal(waited.ok, true);
    if (waited.ok) {
      assert.equal(waited.task.attempts, 1);
      assert.equal(waited.task.status, "WAITING_ON");
    }
    const t2 = {
      taskId: "T2",
      attempts: 0,
      status: "CORRECTION_REQUIRED",
    };
    const t2c = applyCorrection(t2, { hypothesis: "other", evidence: "other-ev" });
    assert.equal(t2c.ok, true);
    if (t2c.ok) {
      assert.equal(t2c.task.attempts, 1);
      assert.equal(t2c.task.taskId, "T2");
    }
    // T1 counter unchanged by T2 work.
    assert.equal(t1.attempts, 1);
  });

  it("dependency closure pauses transitive dependents only; independent work stays ready", () => {
    const tasks = [
      { id: "T1", dependsOn: [], status: "FAILED" },
      { id: "T2", dependsOn: ["T1"], status: "READY" },
      { id: "T3", dependsOn: ["T2"], status: "READY" },
      { id: "T4", dependsOn: [], status: "READY" },
    ];
    const result = dependencyClosure(tasks, "T1");
    assert.ok(!("ok" in result && result.ok === false));
    if (!("ok" in result)) {
      assert.deepEqual(result.stopped, ["T1"]);
      assert.deepEqual(result.waiting, ["T2", "T3"]);
      assert.deepEqual(result.runnable, ["T4"]);
    }
  });

  it("negative: identical retry without new evidence is rejected", () => {
    const task = {
      taskId: "T1",
      attempts: 1,
      lastHypothesis: "same",
      lastEvidence: "same-ev",
      status: "CORRECTION_REQUIRED",
    };
    const verdict = applyCorrection(task, {
      hypothesis: "same",
      evidence: "same-ev",
    });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.equal(verdict.code, "identical_retry_without_new_evidence");
    }
  });

  it("negative: fourth correction is rejected", () => {
    const task = {
      taskId: "T1",
      attempts: 3,
      lastHypothesis: "h3",
      lastEvidence: "e3",
      status: "OWNER_DECISION_REQUIRED",
    };
    const verdict = applyCorrection(task, {
      hypothesis: "h4",
      evidence: "e4",
    });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.equal(verdict.code, "fourth_correction");
    }
  });

  it("negative: dependent proceeds while prerequisite failed is rejected", () => {
    const tasks = [
      { id: "T1", dependsOn: [], status: "FAILED" },
      { id: "T2", dependsOn: ["T1"], status: "IN_PROGRESS" },
    ];
    const result = dependencyClosure(tasks, "T1", { allowDependentProceed: true });
    assert.equal(result.ok, false);
    if (result.ok === false) {
      assert.equal(result.code, "dependent_proceeds");
    }
  });

  it("negative: unrelated work stopped without conflict is rejected", () => {
    const tasks = [
      { id: "T1", dependsOn: [], status: "FAILED" },
      { id: "T9", dependsOn: [], status: "READY" },
    ];
    const result = dependencyClosure(tasks, "T1", { stopUnrelated: true });
    assert.equal(result.ok, false);
    if (result.ok === false) {
      assert.equal(result.code, "unrelated_work_stopped_without_conflict");
    }
  });
});
