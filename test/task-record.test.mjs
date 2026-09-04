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
const AFTER_CANDIDATE_FIELDS = ["candidate_ref", "evidence", "assurance_rounds"];
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

export const CHECKOUT_LEASE_FIELDS = Object.freeze([
  "journey",
  "controller",
  "repository",
  "checkout",
  "branch",
  "candidate_revision",
  "acquired_at",
  "generation",
  "state",
]);

const TERMINAL_JOURNEY = new Set(["COMPLETE", "CANCELLED"]);

/**
 * @typedef {{ code: string, message: string, field?: string }} LeaseDiagnostic
 * @typedef {{
 *   ok: true,
 *   lease: Record<string, unknown>,
 *   dispatch?: boolean,
 *   recovery?: { from_generation: number, to_generation: number, recorded: true },
 * } | {
 *   ok: false,
 *   code: string,
 *   message: string,
 *   status?: string,
 *   competitor?: { journey: string, controller: string },
 *   diagnostics?: LeaseDiagnostic[],
 * }} LeaseVerdict
 */

/**
 * Visible competitor identity only: Journey id and controller. No paths.
 * @param {Record<string, unknown>} lease
 */
export function sanitizeCompetingIdentity(lease) {
  return {
    journey: String(lease.journey ?? ""),
    controller: String(lease.controller ?? ""),
  };
}

/**
 * @param {unknown} lease
 * @returns {{ ok: true, lease: Record<string, unknown> } | { ok: false, diagnostics: LeaseDiagnostic[] }}
 */
export function validateCheckoutLease(lease) {
  /** @type {LeaseDiagnostic[]} */
  const diagnostics = [];
  if (!lease || typeof lease !== "object" || Array.isArray(lease)) {
    return {
      ok: false,
      diagnostics: [{ code: "lease_not_object", message: "checkout lease must be an object" }],
    };
  }
  const rec = /** @type {Record<string, unknown>} */ (lease);
  for (const key of Object.keys(rec)) {
    if (!CHECKOUT_LEASE_FIELDS.includes(key)) {
      diagnostics.push({
        code: "forged_lease",
        message: `hidden/unknown lease field "${key}" is rejected fail closed`,
        field: key,
      });
    }
  }
  for (const field of CHECKOUT_LEASE_FIELDS) {
    if (!(field in rec) || rec[field] === undefined || rec[field] === null) {
      diagnostics.push({
        code: "missing_lease_field",
        message: `lease field "${field}" is required`,
        field,
      });
      continue;
    }
    if (field === "generation") {
      if (!Number.isInteger(rec.generation) || /** @type {number} */ (rec.generation) < 1) {
        diagnostics.push({
          code: "forged_lease",
          message: "generation must be a positive integer",
          field: "generation",
        });
      }
      continue;
    }
    if (field === "state") {
      if (rec.state !== "active" && rec.state !== "released") {
        diagnostics.push({
          code: "forged_lease",
          message: `state "${String(rec.state)}" is not active|released`,
          field: "state",
        });
      }
      continue;
    }
    if (typeof rec[field] !== "string" || rec[field].trim() === "") {
      diagnostics.push({
        code: "fixed_empty_lease_field",
        message: `lease field "${field}" is empty`,
        field,
      });
    }
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  return { ok: true, lease: rec };
}

/**
 * Own authorized progress: the returned candidate's parent is the leased revision.
 * @param {Record<string, unknown>} lease
 * @param {unknown} proposedRevision
 * @param {unknown} parentRevision
 */
function isAuthorizedCandidateAdvance(lease, proposedRevision, parentRevision) {
  return (
    typeof proposedRevision === "string" &&
    proposedRevision.trim() !== "" &&
    proposedRevision !== lease.candidate_revision &&
    parentRevision === lease.candidate_revision
  );
}

/**
 * @param {LeaseAdmission["inventory"]} inventory
 */
function liveCompetitors(inventory, actorJourney, repository, checkout) {
  return (inventory ?? []).filter((entry) => {
    if (TERMINAL_JOURNEY.has(entry.status)) return false;
    if (entry.journey === actorJourney) return false;
    if (entry.repository !== repository || entry.checkout !== checkout) return false;
    if (entry.lease && entry.lease.state === "released") return false;
    return true;
  });
}

/**
 * @typedef {{
 *   inventoried?: boolean,
 *   inventory?: Array<{
 *     journey: string,
 *     status: string,
 *     repository: string,
 *     checkout: string,
 *     lease?: { state?: string, journey?: string, controller?: string, generation?: number },
 *     worktreeApproved?: boolean,
 *     compatible?: boolean,
 *   }>,
 *   actor: {
 *     journey: string,
 *     controller: string,
 *     repository: string,
 *     checkout: string,
 *     branch: string,
 *     candidate_revision: string,
 *   },
 *   existingLease?: Record<string, unknown>,
 *   action: 'acquire'|'resume'|'recover'|'plan_write'|'dispatch',
 *   worktreeApproved?: boolean,
 *   compatible?: boolean,
 *   observed?: { branch?: string, candidate_revision?: string, parent_revision?: string },
 *   alreadyDispatched?: boolean,
 *   presentedGeneration?: number,
 *   explicit?: boolean,
 *   recorded?: boolean,
 *   now?: string,
 * }} LeaseAdmission
 */

/**
 * Router admission: inventory, acquire, resume, recover, then planning write/dispatch.
 * @param {LeaseAdmission} input
 * @returns {LeaseVerdict}
 */
export function admitCheckoutLease(input) {
  if (input.inventoried !== true) {
    return {
      ok: false,
      code: "inventory_required",
      message: "inventory visible nonterminal Journeys before any planning write or dispatch",
    };
  }

  const actor = input.actor;
  const inventory = input.inventory ?? [];
  const competitors = liveCompetitors(
    inventory,
    actor.journey,
    actor.repository,
    actor.checkout
  );

  if (competitors.length) {
    const competitorSource = competitors[0].lease ?? competitors[0];
    return {
      ok: false,
      code: "checkout_lease_conflict",
      status: "WAITING_ON",
      message: "same checkout is owned by a live other Journey",
      competitor: sanitizeCompetingIdentity(
        /** @type {Record<string, unknown>} */ (competitorSource)
      ),
    };
  }

  const otherLive = inventory.filter(
    (entry) =>
      !TERMINAL_JOURNEY.has(entry.status) &&
      entry.journey !== actor.journey &&
      !(entry.lease && entry.lease.state === "released")
  );
  const distinctOthers = otherLive.filter(
    (entry) =>
      entry.repository !== actor.repository || entry.checkout !== actor.checkout
  );
  if (
    distinctOthers.length &&
    (input.worktreeApproved !== true || input.compatible !== true)
  ) {
    const competitorSource = distinctOthers[0].lease ?? distinctOthers[0];
    return {
      ok: false,
      code: "worktree_not_approved",
      status: "WAITING_ON",
      message: "distinct worktrees proceed only when explicitly approved and compatible",
      competitor: sanitizeCompetingIdentity(
        /** @type {Record<string, unknown>} */ (competitorSource)
      ),
    };
  }

  if (input.action === "recover") {
    return recoverStaleLease(input);
  }

  if (input.action === "acquire") {
    if (input.existingLease && input.existingLease.state === "active") {
      return admitCheckoutLease({ ...input, action: "resume" });
    }
    const lease = {
      journey: actor.journey,
      controller: actor.controller,
      repository: actor.repository,
      checkout: actor.checkout,
      branch: actor.branch,
      candidate_revision: actor.candidate_revision,
      acquired_at: input.now ?? "2026-08-18T00:00:00Z",
      generation: 1,
      state: "active",
    };
    const valid = validateCheckoutLease(lease);
    if (!valid.ok) {
      return {
        ok: false,
        code: "forged_lease",
        message: "acquired lease failed validation",
        diagnostics: valid.diagnostics,
      };
    }
    return { ok: true, lease, dispatch: true };
  }

  if (input.action === "resume" || input.action === "plan_write" || input.action === "dispatch") {
    if (!input.existingLease) {
      return {
        ok: false,
        code: "lease_required_before_planning",
        message: "an active checkout lease is required before planning write or dispatch",
      };
    }
    const valid = validateCheckoutLease(input.existingLease);
    if (!valid.ok) {
      return {
        ok: false,
        code: "forged_lease",
        message: "forged lease records fail closed",
        diagnostics: valid.diagnostics,
      };
    }
    const lease = input.existingLease;
    if (lease.state !== "active") {
      return {
        ok: false,
        code: "lease_not_active",
        status: "WAITING_ON",
        message: "released lease cannot authorize planning write or dispatch",
      };
    }
    if (lease.journey !== actor.journey) {
      return {
        ok: false,
        code: "checkout_lease_conflict",
        status: "WAITING_ON",
        message: "existing lease belongs to another Journey",
        competitor: sanitizeCompetingIdentity(lease),
      };
    }
    if (lease.controller !== actor.controller) {
      return {
        ok: false,
        code: "lease_identity_drift",
        status: "WAITING_ON",
        message: "foreign controller cannot use this lease",
      };
    }
    if (
      input.presentedGeneration !== undefined &&
      input.presentedGeneration !== lease.generation
    ) {
      return {
        ok: false,
        code: "stale_generation",
        status: "WAITING_ON",
        message: "stale-generation lease records fail closed",
      };
    }
    let nextLease = lease;
    if (input.observed) {
      if (input.observed.branch !== undefined && input.observed.branch !== lease.branch) {
        return {
          ok: false,
          code: "lease_identity_drift",
          status: "WAITING_ON",
          message: "branch or HEAD drift invalidates the lease before mutation",
        };
      }
      if (
        input.observed.candidate_revision !== undefined &&
        input.observed.candidate_revision !== lease.candidate_revision
      ) {
        if (
          isAuthorizedCandidateAdvance(
            lease,
            input.observed.candidate_revision,
            input.observed.parent_revision
          )
        ) {
          nextLease = { ...lease, candidate_revision: input.observed.candidate_revision };
        } else {
          return {
            ok: false,
            code: "lease_identity_drift",
            status: "WAITING_ON",
            message: "branch or HEAD drift invalidates the lease before mutation",
          };
        }
      }
    }
    if (input.action === "dispatch" && input.alreadyDispatched === true) {
      return {
        ok: false,
        code: "duplicate_dispatch",
        message: "resume must not duplicate a dispatch",
      };
    }
    return {
      ok: true,
      lease: nextLease,
      dispatch: input.action === "resume" ? input.alreadyDispatched !== true : input.action === "dispatch",
    };
  }

  return {
    ok: false,
    code: "unknown_lease_action",
    message: `unknown lease action ${String(input.action)}`,
  };
}

/**
 * @param {LeaseAdmission} input
 * @returns {LeaseVerdict}
 */
export function recoverStaleLease(input) {
  if (input.inventoried !== true) {
    return {
      ok: false,
      code: "inventory_required",
      message: "inventory visible nonterminal Journeys before stale recovery",
    };
  }
  if (input.explicit !== true || input.recorded !== true) {
    return {
      ok: false,
      code: "stale_recovery_not_explicit",
      message: "stale recovery must be explicit and recorded",
    };
  }
  if (!input.existingLease) {
    return {
      ok: false,
      code: "missing_lease",
      message: "stale recovery requires the prior lease record",
    };
  }
  const valid = validateCheckoutLease(input.existingLease);
  if (!valid.ok) {
    return {
      ok: false,
      code: "forged_lease",
      message: "forged lease records fail closed",
      diagnostics: valid.diagnostics,
    };
  }
  const prior = input.existingLease;
  const steal = liveCompetitors(
    input.inventory ?? [],
    input.actor.journey,
    input.actor.repository,
    input.actor.checkout
  );
  if (steal.length || (prior.state === "active" && prior.journey !== input.actor.journey)) {
    return {
      ok: false,
      code: "cannot_steal_live_lease",
      message: "stale recovery cannot steal a live lease",
      competitor: sanitizeCompetingIdentity(
        steal.length
          ? /** @type {Record<string, unknown>} */ (steal[0].lease ?? steal[0])
          : prior
      ),
    };
  }
  const nextGeneration = /** @type {number} */ (prior.generation) + 1;
  const lease = {
    journey: input.actor.journey,
    controller: input.actor.controller,
    repository: input.actor.repository,
    checkout: input.actor.checkout,
    branch: input.actor.branch,
    candidate_revision: input.actor.candidate_revision,
    acquired_at: input.now ?? "2026-08-18T00:00:00Z",
    generation: nextGeneration,
    state: "active",
  };
  const nextValid = validateCheckoutLease(lease);
  if (!nextValid.ok) {
    return {
      ok: false,
      code: "forged_lease",
      message: "recovered lease failed validation",
      diagnostics: nextValid.diagnostics,
    };
  }
  return {
    ok: true,
    lease,
    recovery: {
      from_generation: /** @type {number} */ (prior.generation),
      to_generation: nextGeneration,
      recorded: true,
    },
  };
}

/**
 * @param {Record<string, unknown>} lease
 * @param {{ terminal?: string }} [ctx]
 * @returns {LeaseVerdict}
 */
export function releaseCheckoutLease(lease, ctx = {}) {
  if (ctx.terminal !== "COMPLETE" && ctx.terminal !== "CANCELLED") {
    return {
      ok: false,
      code: "release_requires_terminal",
      message: "release the checkout lease only on COMPLETE or CANCELLED",
    };
  }
  const valid = validateCheckoutLease(lease);
  if (!valid.ok) {
    return {
      ok: false,
      code: "forged_lease",
      message: "forged lease records fail closed",
      diagnostics: valid.diagnostics,
    };
  }
  if (lease.state === "released") {
    return {
      ok: false,
      code: "duplicate_release",
      message: "COMPLETE/CANCELLED releases the checkout lease exactly once",
    };
  }
  return {
    ok: true,
    lease: { ...lease, state: "released" },
  };
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
  it("template records cadence before mapping and journey at the route review", () => {
    assert.match(TEMPLATE, /Journey settings/i);
    assert.match(TEMPLATE, /journey:\s*<Explorer Journey \| Expedition>/i);
    assert.match(
      TEMPLATE,
      /review_cadence:\s*<per-slice \| per-round \| at-end>/i
    );
    assert.match(TEMPLATE, /lineup_snapshot:/i);
    assert.match(TEMPLATE, /recorded before Map the Route/i);
    assert.match(TEMPLATE, /journey[\s\S]*recorded at the\s+route review/i);
    assert.match(TEMPLATE, /does not re-ask early or block/i);
  });

  it("template records snapshot precedence and the dated amendment path", () => {
    assert.match(TEMPLATE, /lineup_snapshot:/i);
    assert.match(TEMPLATE, /authoritative for this Journey/i);
    assert.match(TEMPLATE, /explicit owner-confirmed dated visible amendment/i);
    assert.match(TEMPLATE, /not from the current global defaults file/i);
    assert.match(TEMPLATE, /amendment date/i);
  });

  it("template records a generation-bound checkout lease before planning writes", () => {
    assert.match(TEMPLATE, /checkout_lease:/);
    assert.match(TEMPLATE, /controller:/);
    assert.match(TEMPLATE, /repository:/);
    assert.match(TEMPLATE, /checkout:/);
    assert.match(TEMPLATE, /branch:/);
    assert.match(TEMPLATE, /candidate_revision:/);
    assert.match(TEMPLATE, /acquired_at:/);
    assert.match(TEMPLATE, /generation:/);
    assert.match(TEMPLATE, /state:\s*<active \| released>/);
    assert.match(TEMPLATE, /before any planning write/i);
    assert.match(TEMPLATE, /WAITING_ON/);
    assert.match(TEMPLATE, /sanitized/i);
    assert.match(TEMPLATE, /same generation/i);
    assert.match(TEMPLATE, /exactly\s+once/i);
    assert.match(TEMPLATE, /cannot\s+steal a live lease/i);
  });

  it("Router inventories visible nonterminal Journeys before planning write or dispatch", () => {
    const router = readFileSync(
      path.join(ROOT, "skills/bearing-lite/SKILL.md"),
      "utf8"
    );
    assert.match(router, /Inventory visible nonterminal Journeys/);
    assert.match(router, /generation-bound checkout lease/);
    assert.match(router, /before any planning write or dispatch/);
    assert.match(router, /WAITING_ON/);
    assert.match(router, /sanitized competing/);
    assert.match(router, /Distinct explicitly approved\s+compatible worktrees/);
    assert.match(router, /same lease generation/);
    assert.match(router, /duplicate a dispatch/);
    assert.match(router, /release the checkout lease exactly once/i);
    assert.match(router, /cannot steal a live lease/);
  });

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
        assurance_rounds: 0,
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

  it("checkout lease is Journey-level, not a hidden task field", () => {
    const verdict = validateTaskRecord(
      baseTask({
        // @ts-expect-error intentional fixture
        checkout_lease: { state: "active" },
      })
    );
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.ok(verdict.diagnostics.some((d) => d.code === "hidden_record_field"));
    }
  });
});

function baseLease(overrides = {}) {
  return {
    journey: "J-A",
    controller: "Router",
    repository: "alphazede/bearing-lite",
    checkout: "wt-main",
    branch: "main",
    candidate_revision: "4040dfe",
    acquired_at: "2026-08-18T00:00:00Z",
    generation: 1,
    state: "active",
    ...overrides,
  };
}

function baseActor(overrides = {}) {
  return {
    journey: "J-B",
    controller: "Router",
    repository: "alphazede/bearing-lite",
    checkout: "wt-main",
    branch: "main",
    candidate_revision: "4040dfe",
    ...overrides,
  };
}

describe("CMD-TASK-01 checkout-lease admission", () => {
  it("lease record requires Journey, controller, repository, checkout, branch, revision, time, generation, state", () => {
    const ok = validateCheckoutLease(baseLease());
    assert.equal(ok.ok, true, JSON.stringify(ok));
    if (ok.ok) {
      for (const field of CHECKOUT_LEASE_FIELDS) {
        assert.ok(field in ok.lease, field);
      }
    }
  });

  it("first Journey acquires an active generation-1 lease after inventory", () => {
    const verdict = admitCheckoutLease({
      inventoried: true,
      inventory: [],
      actor: baseActor({ journey: "J-A" }),
      action: "acquire",
    });
    assert.equal(verdict.ok, true, JSON.stringify(verdict));
    if (verdict.ok) {
      assert.equal(verdict.lease.state, "active");
      assert.equal(verdict.lease.generation, 1);
      assert.equal(verdict.lease.journey, "J-A");
    }
  });

  it("planning write or dispatch without inventory is rejected", () => {
    const lease = baseLease();
    for (const action of /** @type {const} */ (["plan_write", "dispatch"])) {
      const verdict = admitCheckoutLease({
        inventoried: false,
        inventory: [],
        actor: baseActor({ journey: "J-A" }),
        existingLease: lease,
        action,
      });
      assert.equal(verdict.ok, false);
      if (!verdict.ok) assert.equal(verdict.code, "inventory_required");
    }
  });

  it("same checkout plus a live other Journey returns WAITING_ON with sanitized identity", () => {
    const live = baseLease({
      journey: "J-A",
      controller: "Router",
      // @ts-expect-error intentional unsanitized fixture
      checkout_path: "/home/owner/secret-wt",
      email: "owner@example.com",
    });
    const verdict = admitCheckoutLease({
      inventoried: true,
      inventory: [
        {
          journey: "J-A",
          status: "IN_PROGRESS",
          repository: "alphazede/bearing-lite",
          checkout: "wt-main",
          lease: live,
        },
      ],
      actor: baseActor({ journey: "J-B" }),
      action: "acquire",
    });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.equal(verdict.status, "WAITING_ON");
      assert.equal(verdict.code, "checkout_lease_conflict");
      assert.deepEqual(verdict.competitor, { journey: "J-A", controller: "Router" });
      assert.equal("checkout_path" in (verdict.competitor ?? {}), false);
      assert.equal("email" in (verdict.competitor ?? {}), false);
    }
  });

  it("distinct explicitly approved compatible worktrees may proceed", () => {
    const verdict = admitCheckoutLease({
      inventoried: true,
      inventory: [
        {
          journey: "J-A",
          status: "IN_PROGRESS",
          repository: "alphazede/bearing-lite",
          checkout: "wt-main",
          lease: baseLease({ checkout: "wt-main" }),
          worktreeApproved: true,
          compatible: true,
        },
      ],
      actor: baseActor({ journey: "J-B", checkout: "wt-hooks" }),
      action: "acquire",
      worktreeApproved: true,
      compatible: true,
    });
    assert.equal(verdict.ok, true, JSON.stringify(verdict));
    if (verdict.ok) {
      assert.equal(verdict.lease.checkout, "wt-hooks");
      assert.equal(verdict.lease.journey, "J-B");
    }
  });

  it("distinct worktrees without explicit approval return WAITING_ON", () => {
    const verdict = admitCheckoutLease({
      inventoried: true,
      inventory: [
        {
          journey: "J-A",
          status: "IN_PROGRESS",
          repository: "alphazede/bearing-lite",
          checkout: "wt-main",
          lease: baseLease(),
        },
      ],
      actor: baseActor({ journey: "J-B", checkout: "wt-hooks" }),
      action: "acquire",
    });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.equal(verdict.status, "WAITING_ON");
      assert.equal(verdict.code, "worktree_not_approved");
    }
  });

  it("resume preserves the same generation and prevents duplicate dispatch", () => {
    const lease = baseLease({ journey: "J-A", generation: 2 });
    const resume = admitCheckoutLease({
      inventoried: true,
      inventory: [
        {
          journey: "J-A",
          status: "IN_PROGRESS",
          repository: "alphazede/bearing-lite",
          checkout: "wt-main",
          lease,
        },
      ],
      actor: baseActor({ journey: "J-A" }),
      existingLease: lease,
      action: "resume",
      alreadyDispatched: true,
      presentedGeneration: 2,
    });
    assert.equal(resume.ok, true, JSON.stringify(resume));
    if (resume.ok) {
      assert.equal(resume.lease.generation, 2);
      assert.equal(resume.dispatch, false);
    }
    const dup = admitCheckoutLease({
      inventoried: true,
      inventory: [
        {
          journey: "J-A",
          status: "IN_PROGRESS",
          repository: "alphazede/bearing-lite",
          checkout: "wt-main",
          lease,
        },
      ],
      actor: baseActor({ journey: "J-A" }),
      existingLease: lease,
      action: "dispatch",
      alreadyDispatched: true,
      presentedGeneration: 2,
    });
    assert.equal(dup.ok, false);
    if (!dup.ok) assert.equal(dup.code, "duplicate_dispatch");
  });

  it("negative: forged or stale-generation lease records fail closed", () => {
    const forged = validateCheckoutLease(
      baseLease({
        // @ts-expect-error intentional fixture
        pid: 999,
        generation: 0,
      })
    );
    assert.equal(forged.ok, false);
    if (!forged.ok) {
      assert.ok(forged.diagnostics.some((d) => d.code === "forged_lease"));
    }
    const stale = admitCheckoutLease({
      inventoried: true,
      inventory: [],
      actor: baseActor({ journey: "J-A" }),
      existingLease: baseLease({ journey: "J-A", generation: 3 }),
      action: "resume",
      presentedGeneration: 1,
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, "stale_generation");
  });

  it("negative: branch or HEAD drift stops the transition before mutation", () => {
    const verdict = admitCheckoutLease({
      inventoried: true,
      inventory: [],
      actor: baseActor({ journey: "J-A" }),
      existingLease: baseLease({ journey: "J-A" }),
      action: "plan_write",
      observed: { branch: "other", candidate_revision: "deadbeef" },
    });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.code, "lease_identity_drift");
  });

  it("COMPLETE or CANCELLED releases the checkout lease exactly once", () => {
    for (const terminal of ["COMPLETE", "CANCELLED"]) {
      const first = releaseCheckoutLease(baseLease(), { terminal });
      assert.equal(first.ok, true, JSON.stringify(first));
      if (first.ok) {
        assert.equal(first.lease.state, "released");
        const second = releaseCheckoutLease(first.lease, { terminal });
        assert.equal(second.ok, false);
        if (!second.ok) assert.equal(second.code, "duplicate_release");
      }
    }
  });

  it("stale recovery is explicit, recorded, and increments generation", () => {
    const prior = baseLease({ state: "released", generation: 2 });
    const silent = recoverStaleLease({
      inventoried: true,
      inventory: [],
      actor: baseActor({ journey: "J-A" }),
      existingLease: prior,
      action: "recover",
    });
    assert.equal(silent.ok, false);
    if (!silent.ok) assert.equal(silent.code, "stale_recovery_not_explicit");

    const recovered = recoverStaleLease({
      inventoried: true,
      inventory: [],
      actor: baseActor({ journey: "J-A" }),
      existingLease: prior,
      action: "recover",
      explicit: true,
      recorded: true,
    });
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    if (recovered.ok) {
      assert.equal(recovered.lease.generation, 3);
      assert.equal(recovered.lease.state, "active");
      assert.deepEqual(recovered.recovery, {
        from_generation: 2,
        to_generation: 3,
        recorded: true,
      });
    }
  });

  it("stale recovery cannot steal a live lease", () => {
    const live = baseLease({ journey: "J-A", state: "active", generation: 4 });
    const steal = recoverStaleLease({
      inventoried: true,
      inventory: [
        {
          journey: "J-A",
          status: "IN_PROGRESS",
          repository: "alphazede/bearing-lite",
          checkout: "wt-main",
          lease: live,
        },
      ],
      actor: baseActor({ journey: "J-B" }),
      existingLease: live,
      action: "recover",
      explicit: true,
      recorded: true,
    });
    assert.equal(steal.ok, false);
    if (!steal.ok) {
      assert.equal(steal.code, "cannot_steal_live_lease");
      assert.deepEqual(steal.competitor, { journey: "J-A", controller: "Router" });
    }

    const bypass = admitCheckoutLease({
      inventoried: true,
      inventory: [
        {
          journey: "J-A",
          status: "IN_PROGRESS",
          repository: "alphazede/bearing-lite",
          checkout: "wt-main",
          lease: live,
        },
      ],
      actor: baseActor({ journey: "J-B" }),
      existingLease: baseLease({ journey: "J-B", state: "released" }),
      action: "recover",
      explicit: true,
      recorded: true,
    });
    assert.equal(bypass.ok, false);
    if (!bypass.ok) {
      assert.equal(bypass.status, "WAITING_ON");
      assert.equal(bypass.code, "checkout_lease_conflict");
    }
  });

  it("authorized same-Journey candidate progress refreshes revision on the same generation", () => {
    const lease = baseLease({
      journey: "J-A",
      candidate_revision: "4040dfe",
      generation: 1,
    });
    const integrate = admitCheckoutLease({
      inventoried: true,
      inventory: [],
      actor: baseActor({ journey: "J-A", candidate_revision: "cafebabe" }),
      existingLease: lease,
      action: "plan_write",
      observed: {
        candidate_revision: "cafebabe",
        parent_revision: "4040dfe",
      },
    });
    assert.equal(integrate.ok, true, JSON.stringify(integrate));
    if (!integrate.ok) return;
    assert.equal(integrate.lease.candidate_revision, "cafebabe");
    assert.equal(integrate.lease.generation, 1);
    assert.equal(integrate.lease.state, "active");

    const next = admitCheckoutLease({
      inventoried: true,
      inventory: [],
      actor: baseActor({ journey: "J-A", candidate_revision: "cafebabe" }),
      existingLease: integrate.lease,
      action: "dispatch",
    });
    assert.equal(next.ok, true, JSON.stringify(next));
    if (!next.ok) return;
    assert.equal(next.dispatch, true);
    assert.equal(next.lease.candidate_revision, "cafebabe");
    assert.equal(next.lease.generation, 1);
  });

  it("foreign controller, unrelated HEAD, and released lease stay WAITING_ON without mutation", () => {
    const lease = baseLease({ journey: "J-A", controller: "Router" });
    const foreignController = admitCheckoutLease({
      inventoried: true,
      inventory: [],
      actor: baseActor({ journey: "J-A", controller: "Other" }),
      existingLease: lease,
      action: "plan_write",
    });
    assert.equal(foreignController.ok, false);
    if (!foreignController.ok) {
      assert.equal(foreignController.status, "WAITING_ON");
      assert.equal(foreignController.write, undefined);
    }

    const unrelatedHead = admitCheckoutLease({
      inventoried: true,
      inventory: [],
      actor: baseActor({ journey: "J-A", candidate_revision: "deadbeef" }),
      existingLease: lease,
      action: "plan_write",
      observed: {
        candidate_revision: "deadbeef",
        parent_revision: "not-the-leased-parent",
      },
    });
    assert.equal(unrelatedHead.ok, false);
    if (!unrelatedHead.ok) {
      assert.equal(unrelatedHead.status, "WAITING_ON");
      assert.equal(unrelatedHead.code, "lease_identity_drift");
    }

    const released = admitCheckoutLease({
      inventoried: true,
      inventory: [],
      actor: baseActor({ journey: "J-A" }),
      existingLease: baseLease({ journey: "J-A", state: "released" }),
      action: "dispatch",
      observed: {
        candidate_revision: "cafebabe",
        parent_revision: "4040dfe",
      },
    });
    assert.equal(released.ok, false);
    if (!released.ok) {
      assert.equal(released.status, "WAITING_ON");
      assert.equal(released.code, "lease_not_active");
    }
  });
});

/** Named Bearing Lite bound. Coordinators honor this; reviewers do not redispatch. */
export const MAX_ASSURANCE_ROUNDS = 1;

const ASSURANCE_TERMINAL_SUCCESS = new Set(["PASS", "ACCEPT", "ACCEPT_WITH_FINDINGS"]);
const ASSURANCE_TERMINAL_STOP = new Set(["BLOCK"]);
const ASSURANCE_COORDINATORS = new Set(["router", "explorer", "navigator"]);

/**
 * @typedef {{
 *   candidate_ref: string,
 *   lineage?: string,
 *   assurance_rounds: number,
 * }} AssuranceRecord
 *
 * @typedef {{
 *   action: 'dispatch' | 'result',
 *   route: 'direct' | 'explorer_wave' | 'expedition',
 *   coordinator: 'router' | 'explorer' | 'navigator',
 *   candidate_ref: string,
 *   lineage?: string,
 *   result?: string,
 * }} AssuranceEvent
 *
 * @typedef {{
 *   ok: boolean,
 *   status?: string,
 *   code?: string,
 *   dispatch: boolean,
 *   repair?: boolean,
 *   terminal?: boolean,
 *   candidate_ref: string,
 *   assurance_rounds: number,
 *   lineage: string,
 * }} AssuranceVerdict
 */

/**
 * Visible per-lineage assurance-round admission. Same rule on every route.
 * @param {AssuranceRecord} record
 * @param {AssuranceEvent} event
 * @returns {AssuranceVerdict}
 */
export function admitAssuranceRound(record, event) {
  const lineage = event.lineage ?? event.candidate_ref;
  const rounds = Number(record.assurance_rounds) || 0;

  if (!ASSURANCE_COORDINATORS.has(event.coordinator)) {
    return {
      ok: false,
      code: "coordinator_must_honor_bound",
      dispatch: false,
      candidate_ref: event.candidate_ref,
      assurance_rounds: rounds,
      lineage,
    };
  }
  if (event.route === "direct" && event.coordinator === "navigator") {
    return {
      ok: false,
      code: "direct_depends_on_navigator",
      dispatch: false,
      candidate_ref: event.candidate_ref,
      assurance_rounds: rounds,
      lineage,
    };
  }

  if (event.action === "dispatch") {
    if (rounds >= MAX_ASSURANCE_ROUNDS) {
      return {
        ok: false,
        status: "OWNER_DECISION_REQUIRED",
        code: "max_assurance_rounds",
        dispatch: false,
        candidate_ref: event.candidate_ref,
        assurance_rounds: rounds,
        lineage,
      };
    }
    return {
      ok: true,
      dispatch: true,
      candidate_ref: event.candidate_ref,
      assurance_rounds: rounds,
      lineage,
    };
  }

  const result = String(event.result ?? "");
  const completed = rounds + 1;
  if (ASSURANCE_TERMINAL_SUCCESS.has(result)) {
    return {
      ok: true,
      status: "COMPLETE",
      dispatch: false,
      terminal: true,
      candidate_ref: event.candidate_ref,
      assurance_rounds: completed,
      lineage,
    };
  }
  if (ASSURANCE_TERMINAL_STOP.has(result)) {
    return {
      ok: true,
      status: "BLOCK",
      dispatch: false,
      terminal: true,
      candidate_ref: event.candidate_ref,
      assurance_rounds: completed,
      lineage,
    };
  }
  if (completed >= MAX_ASSURANCE_ROUNDS) {
    return {
      ok: true,
      status: "CORRECTION_REQUIRED",
      code: "final_repair_closes_gate",
      dispatch: false,
      repair: true,
      candidate_ref: event.candidate_ref,
      assurance_rounds: completed,
      lineage,
    };
  }
  return {
    ok: true,
    status: "CORRECTION_REQUIRED",
    dispatch: false,
    repair: true,
    candidate_ref: event.candidate_ref,
    assurance_rounds: completed,
    lineage,
  };
}

/**
 * @param {'direct'|'explorer_wave'|'expedition'} route
 * @param {'router'|'explorer'|'navigator'} coordinator
 * @param {string[]} results
 * @param {{ lineage?: string, start?: AssuranceRecord }} [opts]
 */
function playAssuranceRoute(route, coordinator, results, opts = {}) {
  const lineage = opts.lineage ?? "L1";
  /** @type {AssuranceRecord} */
  let rec = opts.start ?? { candidate_ref: "cand-0", lineage, assurance_rounds: 0 };
  /** @type {AssuranceVerdict[]} */
  const steps = [];
  for (let i = 0; i < results.length; i += 1) {
    const candidate_ref = `cand-${lineage}-${i}`;
    const dispatched = admitAssuranceRound(rec, {
      action: "dispatch",
      route,
      coordinator,
      candidate_ref,
      lineage,
    });
    steps.push(dispatched);
    if (!dispatched.dispatch) break;
    const finished = admitAssuranceRound(
      { ...rec, assurance_rounds: dispatched.assurance_rounds, lineage },
      {
        action: "result",
        route,
        coordinator,
        candidate_ref,
        lineage,
        result: results[i],
      }
    );
    steps.push(finished);
    rec = {
      candidate_ref,
      lineage,
      assurance_rounds: finished.assurance_rounds,
    };
    if (finished.status === "OWNER_DECISION_REQUIRED" || finished.terminal) break;
  }
  return { record: rec, steps };
}

describe("CMD-TASK-01 assurance-round bound", () => {
  it("template carries one Journey-wide assurance round", () => {
    assert.match(TEMPLATE, /assurance_rounds:/);
    assert.match(TEMPLATE, /single submission/i);
    assert.match(TEMPLATE, /max_assurance_rounds/);
    assert.match(TEMPLATE, /new Journey starts at 0/i);
    assert.match(TEMPLATE, /materially changed new Journey/i);
    assert.match(TEMPLATE, /new Journey is not a way around the bound/i);
  });

  it("Direct route spends the final repair without another review", () => {
    const played = playAssuranceRoute("direct", "router", ["REPAIR_REQUIRED"]);
    const last = played.steps[played.steps.length - 1];
    assert.equal(last.status, "CORRECTION_REQUIRED");
    assert.equal(last.code, "final_repair_closes_gate");
    assert.equal(last.dispatch, false);
    assert.equal(last.repair, true);
    assert.equal(last.assurance_rounds, MAX_ASSURANCE_ROUNDS);
    assert.ok(last.candidate_ref);
    assert.equal(played.record.assurance_rounds, MAX_ASSURANCE_ROUNDS);
    const second = admitAssuranceRound(played.record, {
      action: "dispatch",
      route: "direct",
      coordinator: "router",
      candidate_ref: "cand-L1-1",
      lineage: "L1",
    });
    assert.equal(second.ok, false);
    assert.equal(second.dispatch, false);
    assert.equal(second.status, "OWNER_DECISION_REQUIRED");
    assert.equal(second.candidate_ref, "cand-L1-1");
    assert.equal(second.assurance_rounds, MAX_ASSURANCE_ROUNDS);
  });

  it("Expedition route spends the same final repair before stopping review", () => {
    const played = playAssuranceRoute("expedition", "navigator", ["FAIL"]);
    const last = played.steps[played.steps.length - 1];
    assert.equal(last.status, "CORRECTION_REQUIRED");
    assert.equal(last.code, "final_repair_closes_gate");
    assert.equal(last.repair, true);
    assert.equal(last.candidate_ref, "cand-L1-0");
    assert.equal(last.assurance_rounds, MAX_ASSURANCE_ROUNDS);
  });

  it("PASS or ACCEPT_WITH_FINDINGS at the bound is terminal, not another repair", () => {
    const passAtBound = playAssuranceRoute("direct", "router", ["PASS"]);
    const passLast = passAtBound.steps[passAtBound.steps.length - 1];
    assert.equal(passLast.status, "COMPLETE");
    assert.equal(passLast.terminal, true);
    assert.equal(passLast.assurance_rounds, MAX_ASSURANCE_ROUNDS);

    const residual = playAssuranceRoute("expedition", "navigator", ["ACCEPT_WITH_FINDINGS"]);
    const residualLast = residual.steps[residual.steps.length - 1];
    assert.equal(residualLast.status, "COMPLETE");
    assert.equal(residualLast.terminal, true);
    assert.equal(residualLast.dispatch, false);
  });

  it("a replacement candidate does not reset the Journey-wide count", () => {
    const exhausted = playAssuranceRoute("direct", "router", ["FAIL"]);
    assert.equal(exhausted.record.assurance_rounds, MAX_ASSURANCE_ROUNDS);
    const nextLine = admitAssuranceRound(exhausted.record, {
      action: "dispatch",
      route: "direct",
      coordinator: "router",
      candidate_ref: "cand-new",
      lineage: "L2",
    });
    assert.equal(nextLine.ok, false);
    assert.equal(nextLine.dispatch, false);
    assert.equal(nextLine.assurance_rounds, MAX_ASSURANCE_ROUNDS);
    assert.equal(nextLine.lineage, "L2");
  });

  it("Direct must not import Navigator to enforce the bound", () => {
    const verdict = admitAssuranceRound(
      { candidate_ref: "cand-0", lineage: "L1", assurance_rounds: 0 },
      {
        action: "dispatch",
        route: "direct",
        coordinator: "navigator",
        candidate_ref: "cand-0",
        lineage: "L1",
      }
    );
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, "direct_depends_on_navigator");
    assert.equal(verdict.dispatch, false);
  });
});
