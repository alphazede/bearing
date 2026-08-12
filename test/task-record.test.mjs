/**
 * CMD-TASK-01 / SEIT-TASK-RECORD-01, SEIT-SINGLE-WRITER-01
 * Tiered task fields, depends_on task_id list, single-writer coordination.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = readFileSync(
  path.join(ROOT, "skills/bearing-lite/templates/task.md"),
  "utf8"
);

const ALWAYS_FIELDS = [
  "task_id",
  "outcome",
  "status",
  "assigned_role",
  "depends_on",
  "next_action",
];
const BEFORE_EXECUTION_FIELDS = ["scope", "authority", "required_assurance"];
const AFTER_CANDIDATE_FIELDS = ["candidate_ref", "evidence"];
const WAITING_CORRECTING_FIELDS = ["blocker", "attempts"];
const KNOWN_FIELDS = new Set([
  ...ALWAYS_FIELDS,
  ...BEFORE_EXECUTION_FIELDS,
  ...AFTER_CANDIDATE_FIELDS,
  ...WAITING_CORRECTING_FIELDS,
]);

const STATUSES = new Set([
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

/**
 * @typedef {{ code: string, message: string, field?: string }} TaskDiagnostic
 * @typedef {{ ok: true, task: Record<string, unknown> } | { ok: false, diagnostics: TaskDiagnostic[] }} TaskVerdict
 */

/**
 * @param {Record<string, unknown>} task
 * @param {{ phase?: 'always'|'before_execution'|'after_candidate'|'waiting_correcting', writer?: string, parentCoordinator?: string, priorRevision?: string, observedRevision?: string }} [ctx]
 * @returns {TaskVerdict}
 */
export function validateTaskRecord(task, ctx = {}) {
  /** @type {TaskDiagnostic[]} */
  const diagnostics = [];
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    return {
      ok: false,
      diagnostics: [{ code: "task_not_object", message: "task must be an object" }],
    };
  }

  for (const key of Object.keys(task)) {
    if (!KNOWN_FIELDS.has(key) && key !== "writer" && key !== "revision") {
      diagnostics.push({
        code: "hidden_record_field",
        message: `hidden/unknown task field "${key}" is not in the template contract`,
        field: key,
      });
    }
  }

  for (const field of ALWAYS_FIELDS) {
    if (!(field in task) || task[field] === undefined || task[field] === null) {
      diagnostics.push({
        code: "missing_required_field",
        message: `always-present field "${field}" is missing`,
        field,
      });
      continue;
    }
    if (typeof task[field] === "string" && task[field].trim() === "" && field !== "depends_on") {
      diagnostics.push({
        code: "fixed_empty_required_field",
        message: `required field "${field}" is fixed empty`,
        field,
      });
    }
  }

  if (typeof task.status === "string" && !STATUSES.has(task.status)) {
    diagnostics.push({
      code: "invalid_status",
      message: `status "${task.status}" is not a declared state`,
      field: "status",
    });
  }

  // depends_on is task_id list only.
  if ("depends_on" in task) {
    const deps = task.depends_on;
    if (!Array.isArray(deps)) {
      diagnostics.push({
        code: "malformed_dependency_link",
        message: "depends_on must be a list of task_id values only",
        field: "depends_on",
      });
    } else {
      for (const dep of deps) {
        if (typeof dep !== "string" || !/^T[A-Za-z0-9_-]+$/.test(dep)) {
          diagnostics.push({
            code: "malformed_dependency_link",
            message: `depends_on entry ${JSON.stringify(dep)} is not a task_id`,
            field: "depends_on",
          });
        }
        if (typeof dep === "string" && /\s/.test(dep)) {
          diagnostics.push({
            code: "malformed_dependency_link",
            message: "depends_on must not contain prose",
            field: "depends_on",
          });
        }
      }
    }
  }

  const phase = ctx.phase ?? "always";
  if (phase === "before_execution" || phase === "after_candidate" || phase === "waiting_correcting") {
    for (const field of BEFORE_EXECUTION_FIELDS) {
      if (!(field in task)) {
        diagnostics.push({
          code: "missing_before_execution_field",
          message: `before-execution field "${field}" required when leaving PROPOSED`,
          field,
        });
      }
    }
  }
  if (phase === "after_candidate" || phase === "waiting_correcting") {
    for (const field of AFTER_CANDIDATE_FIELDS) {
      if (!(field in task)) {
        diagnostics.push({
          code: "missing_after_candidate_field",
          message: `after-candidate field "${field}" required when evidence exists`,
          field,
        });
      }
    }
  }
  if (phase === "waiting_correcting") {
    for (const field of WAITING_CORRECTING_FIELDS) {
      if (!(field in task)) {
        diagnostics.push({
          code: "missing_waiting_correcting_field",
          message: `waiting/correcting field "${field}" required`,
          field,
        });
      }
    }
  }

  // Single-writer: only parent coordinator may write transitions.
  const parent = ctx.parentCoordinator ?? "explorer";
  if (ctx.writer !== undefined && ctx.writer !== parent) {
    const workerRoles = new Set(["crewmate", "validator", "park-ranger", "surveyor"]);
    if (workerRoles.has(ctx.writer) || ctx.writer !== parent) {
      diagnostics.push({
        code: "wrong_writer",
        message: `writer "${ctx.writer}" may not overwrite task state owned by parent coordinator "${parent}"`,
        field: "writer",
      });
    }
  }

  // Unexpected concurrent edit: preserve foreign revision; reject silent replace.
  if (
    ctx.priorRevision !== undefined &&
    ctx.observedRevision !== undefined &&
    ctx.priorRevision !== ctx.observedRevision
  ) {
    diagnostics.push({
      code: "concurrent_edit_preserved",
      message: `unexpected concurrent edit detected (prior ${ctx.priorRevision} vs observed ${ctx.observedRevision}); preserve foreign edit and reject overwrite`,
      field: "revision",
    });
  }

  if (diagnostics.length) return { ok: false, diagnostics };
  return { ok: true, task };
}

function baseTask(overrides = {}) {
  return {
    task_id: "T1",
    outcome: "add S8 tests",
    status: "PROPOSED",
    assigned_role: "crewmate",
    depends_on: [],
    next_action: "implement write set",
    ...overrides,
  };
}

describe("CMD-TASK-01 task-record (SEIT-TASK-RECORD-01, SEIT-SINGLE-WRITER-01)", () => {
  it("template documents always-present, before-execution, after-candidate, waiting/correcting tiers", () => {
    assert.match(TEMPLATE, /Always present/i);
    assert.match(TEMPLATE, /Before execution/i);
    assert.match(TEMPLATE, /After candidate work/i);
    assert.match(TEMPLATE, /Waiting or correcting only/i);
    for (const f of ALWAYS_FIELDS) assert.match(TEMPLATE, new RegExp(f));
    for (const f of BEFORE_EXECUTION_FIELDS) assert.match(TEMPLATE, new RegExp(f));
    for (const f of AFTER_CANDIDATE_FIELDS) assert.match(TEMPLATE, new RegExp(f));
    for (const f of WAITING_CORRECTING_FIELDS) assert.match(TEMPLATE, new RegExp(f));
    assert.match(TEMPLATE, /depends_on.*task_id/i);
    assert.match(TEMPLATE, /Single-writer/i);
  });

  it("valid always-present task record accepts", () => {
    const verdict = validateTaskRecord(baseTask());
    assert.equal(verdict.ok, true, JSON.stringify(verdict));
  });

  it("depends_on is task_id list only", () => {
    const ok = validateTaskRecord(baseTask({ depends_on: ["T2", "T3"] }));
    assert.equal(ok.ok, true);
    const bad = validateTaskRecord(
      baseTask({ depends_on: ["wait for design approval from owner"] })
    );
    assert.equal(bad.ok, false);
    if (!bad.ok) {
      assert.ok(bad.diagnostics.some((d) => d.code === "malformed_dependency_link"));
    }
  });

  it("before-execution and after-candidate phases require tiered fields", () => {
    const before = validateTaskRecord(
      {
        ...baseTask({ status: "READY" }),
        scope: "test/",
        authority: "S8 write set",
        required_assurance: "none",
      },
      { phase: "before_execution" }
    );
    assert.equal(before.ok, true, JSON.stringify(before));

    const after = validateTaskRecord(
      {
        ...baseTask({ status: "EVIDENCE_READY" }),
        scope: "test/",
        authority: "S8",
        required_assurance: "none",
        candidate_ref: "cand-1",
        evidence: "tests pass",
      },
      { phase: "after_candidate" }
    );
    assert.equal(after.ok, true, JSON.stringify(after));
  });

  it("single-writer: parent coordinator owns transitions; worker overwrite rejected", () => {
    const parentWrite = validateTaskRecord(baseTask({ status: "READY" }), {
      writer: "explorer",
      parentCoordinator: "explorer",
    });
    assert.equal(parentWrite.ok, true);

    const workerOverwrite = validateTaskRecord(baseTask({ status: "COMPLETE" }), {
      writer: "crewmate",
      parentCoordinator: "explorer",
    });
    assert.equal(workerOverwrite.ok, false);
    if (!workerOverwrite.ok) {
      assert.ok(workerOverwrite.diagnostics.some((d) => d.code === "wrong_writer"));
    }

    const validatorWrite = validateTaskRecord(baseTask({ status: "VALIDATING" }), {
      writer: "validator",
      parentCoordinator: "navigator",
    });
    assert.equal(validatorWrite.ok, false);
    if (!validatorWrite.ok) {
      assert.ok(validatorWrite.diagnostics.some((d) => d.code === "wrong_writer"));
    }
  });

  it("unexpected concurrent edit is preserved and overwrite rejected", () => {
    const verdict = validateTaskRecord(baseTask(), {
      writer: "explorer",
      parentCoordinator: "explorer",
      priorRevision: "rev-a",
      observedRevision: "rev-b-foreign",
    });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.ok(verdict.diagnostics.some((d) => d.code === "concurrent_edit_preserved"));
    }
  });

  it("negative: hidden record fields fail", () => {
    const verdict = validateTaskRecord(
      baseTask({
        // @ts-expect-error intentional fixture
        _secret_ledger: { attempts: 99 },
        hidden_score: 1,
      })
    );
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.ok(verdict.diagnostics.some((d) => d.code === "hidden_record_field"));
    }
  });

  it("negative: fixed empty required fields fail", () => {
    const verdict = validateTaskRecord(baseTask({ outcome: "", next_action: "   " }));
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.ok(verdict.diagnostics.some((d) => d.code === "fixed_empty_required_field"));
    }
  });

  it("negative: malformed dependency links fail", () => {
    const verdict = validateTaskRecord(baseTask({ depends_on: "T2 and also the design doc" }));
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.ok(verdict.diagnostics.some((d) => d.code === "malformed_dependency_link"));
    }
  });
});
