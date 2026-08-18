/**
 * CMD-ROUTING-01 / SEIT-ROUTING-01
 * Direct, Explorer-owned wave, and Expedition routes; dormancy negatives.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

/** @typedef {'crewmate'|'explorer'|'navigator'|'validator'|'park-ranger'|'surveyor'} Role */

/**
 * @typedef {{
 *   kind: 'direct' | 'explorer_wave' | 'expedition',
 *   packetCount?: number,
 *   multiWaveConflict?: boolean,
 *   nestedLanes?: number,
 *   requiredAssurance?: string[],
 *   explorerImplements?: boolean,
 *   forceControllersOnSinglePacket?: boolean,
 *   omitWaveCoordination?: boolean,
 * }} RouteInput
 *
 * @typedef {{
 *   ok: true,
 *   active: Role[],
 *   dormant: Role[],
 *   coordinators: Role[],
 *   workers: Role[],
 * } | {
 *   ok: false,
 *   code: string,
 *   message: string,
 * }} RouteVerdict
 */

const ALL_ROLES = /** @type {const} */ ([
  "crewmate",
  "explorer",
  "navigator",
  "validator",
  "park-ranger",
  "surveyor",
]);

/**
 * Select the smallest valid route for a fixture input (pure policy model of product contracts).
 * @param {RouteInput} input
 * @returns {RouteVerdict}
 */
export function selectRoute(input) {
  // Negative policy violations first.
  if (input.explorerImplements === true) {
    return {
      ok: false,
      code: "explorer_performs_packet_work",
      message: "Explorer must not implement packet work; assign Crewmate",
    };
  }
  if (input.forceControllersOnSinglePacket === true && (input.packetCount ?? 1) <= 1) {
    return {
      ok: false,
      code: "single_packet_forces_controllers",
      message: "Single packet must not force coordination roles",
    };
  }
  if (input.kind === "expedition" && input.omitWaveCoordination === true) {
    return {
      ok: false,
      code: "expedition_omits_wave_coordination",
      message: "Expedition requires Navigator wave coordination",
    };
  }

  /** @type {Role[]} */
  const active = [];

  if (input.kind === "direct") {
    active.push("crewmate");
  } else if (input.kind === "explorer_wave") {
    active.push("explorer", "crewmate");
  } else if (input.kind === "expedition") {
    active.push("navigator", "explorer", "crewmate");
  } else {
    return {
      ok: false,
      code: "unknown_route_kind",
      message: `unknown route kind`,
    };
  }

  const assurance = input.requiredAssurance ?? [];
  for (const role of assurance) {
    const key = String(role).toLowerCase().replace(/[\s_]+/g, "-");
    if (key === "validator" && !active.includes("validator")) active.push("validator");
    if ((key === "park-ranger" || key === "parkranger") && !active.includes("park-ranger")) {
      active.push("park-ranger");
    }
    if (key === "surveyor" && !active.includes("surveyor")) active.push("surveyor");
  }

  const activeSet = new Set(active);
  const dormant = ALL_ROLES.filter((r) => !activeSet.has(r));
  const coordinators = active.filter((r) => ["explorer", "navigator"].includes(r));
  const workers = active.filter((r) => r === "crewmate");

  // Direct never activates controllers.
  if (input.kind === "direct") {
    assert.ok(!active.includes("navigator"));
    assert.ok(!active.includes("explorer"));
  }

  return {
    ok: true,
    active: [...active],
    dormant,
    coordinators,
    workers,
  };
}

describe("CMD-ROUTING-01 role-routing (SEIT-ROUTING-01)", () => {
  it("Direct: Crewmate only (+ optional assurance) with self-check path", () => {
    const verdict = selectRoute({ kind: "direct", packetCount: 1, requiredAssurance: [] });
    assert.equal(verdict.ok, true);
    if (verdict.ok) {
      assert.deepEqual(verdict.active, ["crewmate"]);
      assert.deepEqual(verdict.workers, ["crewmate"]);
      assert.deepEqual(verdict.coordinators, []);
      assert.ok(verdict.dormant.includes("explorer"));
      assert.ok(verdict.dormant.includes("navigator"));
    }
  });

  it("Explorer-owned wave: Explorer + Crewmates; Explorer does not implement", () => {
    const verdict = selectRoute({
      kind: "explorer_wave",
      packetCount: 3,
      requiredAssurance: [],
    });
    assert.equal(verdict.ok, true);
    if (verdict.ok) {
      assert.ok(verdict.active.includes("explorer"));
      assert.ok(verdict.active.includes("crewmate"));
      assert.ok(!verdict.active.includes("navigator"));
      assert.ok(verdict.dormant.includes("navigator"));
    }
  });

  it("Expedition: Navigator sequences waves and conflicts; Explorer owns lanes", () => {
    const simple = selectRoute({ kind: "expedition", packetCount: 4 });
    assert.equal(simple.ok, true);
    if (simple.ok) {
      assert.ok(simple.active.includes("navigator"));
      assert.ok(simple.active.includes("explorer"));
      assert.ok(simple.active.includes("crewmate"));
      assert.deepEqual(simple.coordinators, ["navigator", "explorer"]);
    }
    const conflicted = selectRoute({
      kind: "expedition",
      multiWaveConflict: true,
      nestedLanes: 2,
    });
    assert.equal(conflicted.ok, true);
    if (conflicted.ok) {
      assert.deepEqual(conflicted.active, ["navigator", "explorer", "crewmate"]);
      assert.deepEqual(conflicted.coordinators, ["navigator", "explorer"]);
    }
  });

  it("negative: removed delegated route is rejected", () => {
    const verdict = selectRoute({ kind: "delegated" });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.code, "unknown_route_kind");
  });

  it("dormant roles create no work entries in the route fixture", () => {
    const verdict = selectRoute({ kind: "direct" });
    assert.equal(verdict.ok, true);
    if (verdict.ok) {
      for (const role of verdict.dormant) {
        assert.ok(!verdict.active.includes(role));
        assert.ok(!verdict.coordinators.includes(role));
        assert.ok(!verdict.workers.includes(role));
      }
    }
  });

  it("negative: Explorer performs packet work is rejected", () => {
    const verdict = selectRoute({
      kind: "explorer_wave",
      explorerImplements: true,
    });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.equal(verdict.code, "explorer_performs_packet_work");
    }
  });

  it("negative: single packet forces controllers is rejected", () => {
    const verdict = selectRoute({
      kind: "direct",
      packetCount: 1,
      forceControllersOnSinglePacket: true,
    });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.equal(verdict.code, "single_packet_forces_controllers");
    }
  });

  it("negative: Expedition omits wave coordination is rejected", () => {
    const verdict = selectRoute({
      kind: "expedition",
      omitWaveCoordination: true,
    });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.equal(verdict.code, "expedition_omits_wave_coordination");
    }
  });
});

/** Visible #33A lease fields. Packet B revalidates this record; it does not add fields. */
const VISIBLE_LEASE_FIELDS = Object.freeze([
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

const LEASE_IDENTITY_FIELDS = Object.freeze([
  "journey",
  "repository",
  "checkout",
  "branch",
  "generation",
]);

/** @typedef {'navigator'|'explorer'|'crewmate'} ExecutionRole */
/** @typedef {'first_write'|'mutation'|'dispatch'|'integration'|'cross_wave_transition'} LeaseBoundary */

export const REQUIRED_LEASE_BOUNDARIES = Object.freeze({
  navigator: Object.freeze([
    "first_write",
    "dispatch",
    "integration",
    "cross_wave_transition",
  ]),
  explorer: Object.freeze(["first_write", "dispatch", "integration"]),
  crewmate: Object.freeze(["first_write", "mutation"]),
});

/**
 * @typedef {{
 *   role: ExecutionRole,
 *   boundary: LeaseBoundary,
 *   lease?: Record<string, unknown> | null,
 *   approved: {
 *     journey: string,
 *     repository: string,
 *     checkout: string,
 *     branch: string,
 *     candidate_revision: string,
 *     generation: number,
 *     controller?: string,
 *   },
 *   observed?: {
 *     branch?: string,
 *     candidate_revision?: string,
 *     generation?: number,
 *     parent_revision?: string,
 *     controller?: string,
 *   },
 *   alreadyDispatched?: boolean,
 * }} ExecutionLeaseInput
 *
 * @typedef {{
 *   ok: true,
 *   write: boolean,
 *   dispatch: boolean,
 *   lease: Record<string, unknown>,
 * } | {
 *   ok: false,
 *   code: string,
 *   status: 'WAITING_ON',
 *   message: string,
 *   write: false,
 *   dispatch: false,
 * }} ExecutionLeaseVerdict
 */

/**
 * @param {ExecutionRole} role
 * @param {string} code
 * @param {string} message
 * @returns {ExecutionLeaseVerdict}
 */
function leaseMismatch(role, code, message) {
  return {
    ok: false,
    code,
    status: "WAITING_ON",
    message:
      role === "crewmate" ? `${message}; return WAITING_ON without writing` : message,
    write: false,
    dispatch: false,
  };
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
 * Revalidate the visible checkout lease at one execution boundary.
 * Does not acquire, resume, recover, or release; those stay Router-owned.
 * @param {ExecutionLeaseInput} input
 * @returns {ExecutionLeaseVerdict}
 */
export function revalidateExecutionLease(input) {
  const required = REQUIRED_LEASE_BOUNDARIES[input.role];
  if (!required) {
    return leaseMismatch(
      input.role,
      "unknown_execution_role",
      "only Navigator, Explorer, and Crewmate revalidate at execution boundaries"
    );
  }
  if (!required.includes(input.boundary)) {
    return leaseMismatch(
      input.role,
      "undeclared_execution_boundary",
      `${input.role} has no ${input.boundary} lease-revalidation boundary`
    );
  }

  const lease = input.lease;
  if (!lease || typeof lease !== "object" || Array.isArray(lease)) {
    return leaseMismatch(input.role, "forged_lease", "forged lease records fail closed");
  }
  for (const key of Object.keys(lease)) {
    if (!VISIBLE_LEASE_FIELDS.includes(key)) {
      return leaseMismatch(input.role, "forged_lease", "forged lease records fail closed");
    }
  }
  for (const field of VISIBLE_LEASE_FIELDS) {
    if (!(field in lease) || lease[field] === undefined || lease[field] === null) {
      return leaseMismatch(input.role, "forged_lease", "forged lease records fail closed");
    }
  }
  if (!Number.isInteger(lease.generation) || /** @type {number} */ (lease.generation) < 1) {
    return leaseMismatch(input.role, "forged_lease", "forged lease records fail closed");
  }
  if (lease.state !== "active" && lease.state !== "released") {
    return leaseMismatch(input.role, "forged_lease", "forged lease records fail closed");
  }
  if (lease.state !== "active") {
    return leaseMismatch(
      input.role,
      "lease_not_active",
      "released lease cannot authorize mutation, dispatch, or integration"
    );
  }

  const approved = input.approved;
  for (const field of LEASE_IDENTITY_FIELDS) {
    if (lease[field] !== approved[field]) {
      const code =
        field === "generation"
          ? "stale_generation"
          : field === "journey"
            ? "checkout_lease_conflict"
            : "lease_identity_drift";
      return leaseMismatch(
        input.role,
        code,
        `${field} no longer matches the approved checkout lease`
      );
    }
  }
  if (approved.controller !== undefined && approved.controller !== lease.controller) {
    return leaseMismatch(
      input.role,
      "lease_identity_drift",
      "controller no longer matches the approved checkout lease"
    );
  }

  const observed = input.observed;
  if (observed) {
    if (observed.branch !== undefined && observed.branch !== lease.branch) {
      return leaseMismatch(
        input.role,
        "lease_identity_drift",
        "branch or HEAD drift invalidates the lease before mutation"
      );
    }
    if (observed.generation !== undefined && observed.generation !== lease.generation) {
      return leaseMismatch(
        input.role,
        "stale_generation",
        "stale-generation lease records fail closed"
      );
    }
    if (observed.controller !== undefined && observed.controller !== lease.controller) {
      return leaseMismatch(
        input.role,
        "lease_identity_drift",
        "foreign controller cannot use this lease"
      );
    }
  }

  const proposedRevision =
    observed && observed.candidate_revision !== undefined
      ? observed.candidate_revision
      : approved.candidate_revision;
  const parentRevision = observed ? observed.parent_revision : undefined;
  let nextLease = lease;
  if (proposedRevision !== lease.candidate_revision) {
    if (isAuthorizedCandidateAdvance(lease, proposedRevision, parentRevision)) {
      nextLease = { ...lease, candidate_revision: proposedRevision };
    } else {
      return leaseMismatch(
        input.role,
        "lease_identity_drift",
        "branch or HEAD drift invalidates the lease before mutation"
      );
    }
  }

  return {
    ok: true,
    write: input.role === "crewmate",
    dispatch: input.boundary === "dispatch" && input.alreadyDispatched !== true,
    lease: nextLease,
  };
}

function fixtureLease(overrides = {}) {
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

function fixtureApproved(overrides = {}) {
  return {
    journey: "J-A",
    repository: "alphazede/bearing-lite",
    checkout: "wt-main",
    branch: "main",
    candidate_revision: "4040dfe",
    generation: 1,
    ...overrides,
  };
}

describe("CMD-ROUTING-01 checkout-lease revalidation", () => {
  it("every execution role revalidates identity before its first write", () => {
    for (const role of /** @type {const} */ (["navigator", "explorer", "crewmate"])) {
      assert.ok(REQUIRED_LEASE_BOUNDARIES[role].includes("first_write"), role);
      const ok = revalidateExecutionLease({
        role,
        boundary: "first_write",
        lease: fixtureLease(),
        approved: fixtureApproved(),
      });
      assert.equal(ok.ok, true, role);
      const drifted = revalidateExecutionLease({
        role,
        boundary: "first_write",
        lease: fixtureLease(),
        approved: fixtureApproved({ repository: "other/repo" }),
      });
      assert.equal(drifted.ok, false);
      if (!drifted.ok) {
        assert.equal(drifted.write, false);
        assert.equal(drifted.dispatch, false);
        assert.equal(drifted.status, "WAITING_ON");
        assert.equal(drifted.code, "lease_identity_drift");
      }
    }
  });

  it("Navigator revalidates before dispatch, integration, and cross-wave transition", () => {
    assert.deepEqual(REQUIRED_LEASE_BOUNDARIES.navigator, [
      "first_write",
      "dispatch",
      "integration",
      "cross_wave_transition",
    ]);
    for (const boundary of REQUIRED_LEASE_BOUNDARIES.navigator) {
      const verdict = revalidateExecutionLease({
        role: "navigator",
        boundary,
        lease: fixtureLease({ state: "released" }),
        approved: fixtureApproved(),
      });
      assert.equal(verdict.ok, false, boundary);
      if (!verdict.ok) {
        assert.equal(verdict.write, false);
        assert.equal(verdict.dispatch, false);
      }
    }
  });

  it("Explorer revalidates before dispatch and integration", () => {
    assert.deepEqual(REQUIRED_LEASE_BOUNDARIES.explorer, [
      "first_write",
      "dispatch",
      "integration",
    ]);
    for (const boundary of ["dispatch", "integration"]) {
      const verdict = revalidateExecutionLease({
        role: "explorer",
        boundary: /** @type {LeaseBoundary} */ (boundary),
        lease: fixtureLease({ checkout: "wt-other" }),
        approved: fixtureApproved(),
      });
      assert.equal(verdict.ok, false, boundary);
      if (!verdict.ok) {
        assert.equal(verdict.code, "lease_identity_drift");
        assert.equal(verdict.dispatch, false);
      }
    }
  });

  it("Crewmate revalidates before every mutation and returns WAITING_ON without writing", () => {
    assert.deepEqual(REQUIRED_LEASE_BOUNDARIES.crewmate, ["first_write", "mutation"]);
    const mismatch = revalidateExecutionLease({
      role: "crewmate",
      boundary: "mutation",
      lease: fixtureLease({ journey: "J-B" }),
      approved: fixtureApproved(),
    });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) {
      assert.equal(mismatch.status, "WAITING_ON");
      assert.equal(mismatch.write, false);
      assert.equal(mismatch.dispatch, false);
      assert.match(mismatch.message, /WAITING_ON without writing/);
    }
    const allowed = revalidateExecutionLease({
      role: "crewmate",
      boundary: "mutation",
      lease: fixtureLease(),
      approved: fixtureApproved(),
    });
    assert.equal(allowed.ok, true);
    if (allowed.ok) assert.equal(allowed.write, true);
  });

  it("branch, HEAD, and generation drift fail closed", () => {
    const cases = [
      {
        observed: { branch: "other" },
        code: "lease_identity_drift",
      },
      {
        observed: { candidate_revision: "deadbeef" },
        code: "lease_identity_drift",
      },
      {
        observed: { generation: 0 },
        code: "stale_generation",
      },
      {
        approved: fixtureApproved({ generation: 2 }),
        code: "stale_generation",
      },
    ];
    for (const fixture of cases) {
      const verdict = revalidateExecutionLease({
        role: "explorer",
        boundary: "dispatch",
        lease: fixtureLease(),
        approved: fixture.approved ?? fixtureApproved(),
        observed: fixture.observed,
      });
      assert.equal(verdict.ok, false, fixture.code);
      if (!verdict.ok) {
        assert.equal(verdict.code, fixture.code);
        assert.equal(verdict.write, false);
        assert.equal(verdict.dispatch, false);
      }
    }
  });

  it("released, stale, and forged leases fail closed", () => {
    const released = revalidateExecutionLease({
      role: "navigator",
      boundary: "integration",
      lease: fixtureLease({ state: "released" }),
      approved: fixtureApproved(),
    });
    assert.equal(released.ok, false);
    if (!released.ok) assert.equal(released.code, "lease_not_active");

    const stale = revalidateExecutionLease({
      role: "navigator",
      boundary: "dispatch",
      lease: fixtureLease({ generation: 3 }),
      approved: fixtureApproved({ generation: 3 }),
      observed: { generation: 1 },
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, "stale_generation");

    const forged = revalidateExecutionLease({
      role: "crewmate",
      boundary: "mutation",
      lease: fixtureLease({
        // @ts-expect-error intentional fixture
        pid: 999,
      }),
      approved: fixtureApproved(),
    });
    assert.equal(forged.ok, false);
    if (!forged.ok) {
      assert.equal(forged.code, "forged_lease");
      assert.equal(forged.write, false);
      assert.equal(forged.status, "WAITING_ON");
    }
  });

  it("same valid lease continues without duplicate dispatch", () => {
    const first = revalidateExecutionLease({
      role: "navigator",
      boundary: "dispatch",
      lease: fixtureLease(),
      approved: fixtureApproved(),
    });
    assert.equal(first.ok, true);
    if (first.ok) assert.equal(first.dispatch, true);

    const resume = revalidateExecutionLease({
      role: "navigator",
      boundary: "dispatch",
      lease: fixtureLease(),
      approved: fixtureApproved(),
      alreadyDispatched: true,
    });
    assert.equal(resume.ok, true);
    if (resume.ok) {
      assert.equal(resume.dispatch, false);
      assert.equal(resume.write, false);
    }

    const wave = revalidateExecutionLease({
      role: "explorer",
      boundary: "integration",
      lease: fixtureLease(),
      approved: fixtureApproved(),
      alreadyDispatched: true,
    });
    assert.equal(wave.ok, true);
    if (wave.ok) assert.equal(wave.dispatch, false);
  });

  it("authorized same-Journey candidate progress refreshes revision on the same generation", () => {
    const lease = fixtureLease({ candidate_revision: "4040dfe", generation: 1 });
    const integrate = revalidateExecutionLease({
      role: "explorer",
      boundary: "integration",
      lease,
      approved: fixtureApproved({ candidate_revision: "cafebabe" }),
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
    assert.equal(integrate.write, false);

    const nextDispatch = revalidateExecutionLease({
      role: "explorer",
      boundary: "dispatch",
      lease: integrate.lease,
      approved: fixtureApproved({ candidate_revision: "cafebabe" }),
    });
    assert.equal(nextDispatch.ok, true, JSON.stringify(nextDispatch));
    if (!nextDispatch.ok) return;
    assert.equal(nextDispatch.dispatch, true);
    assert.equal(nextDispatch.lease.candidate_revision, "cafebabe");
    assert.equal(nextDispatch.lease.generation, 1);

    const nextWrite = revalidateExecutionLease({
      role: "crewmate",
      boundary: "mutation",
      lease: integrate.lease,
      approved: fixtureApproved({ candidate_revision: "cafebabe" }),
    });
    assert.equal(nextWrite.ok, true, JSON.stringify(nextWrite));
    if (!nextWrite.ok) return;
    assert.equal(nextWrite.write, true);
  });

  it("foreign controller, unrelated HEAD, and released lease stay WAITING_ON without mutation", () => {
    const foreignController = revalidateExecutionLease({
      role: "explorer",
      boundary: "integration",
      lease: fixtureLease(),
      approved: fixtureApproved({ controller: "Other" }),
    });
    assert.equal(foreignController.ok, false);
    if (!foreignController.ok) {
      assert.equal(foreignController.status, "WAITING_ON");
      assert.equal(foreignController.write, false);
      assert.equal(foreignController.dispatch, false);
    }

    const unrelatedHead = revalidateExecutionLease({
      role: "explorer",
      boundary: "integration",
      lease: fixtureLease({ candidate_revision: "4040dfe" }),
      approved: fixtureApproved({ candidate_revision: "deadbeef" }),
      observed: {
        candidate_revision: "deadbeef",
        parent_revision: "not-the-leased-parent",
      },
    });
    assert.equal(unrelatedHead.ok, false);
    if (!unrelatedHead.ok) {
      assert.equal(unrelatedHead.status, "WAITING_ON");
      assert.equal(unrelatedHead.code, "lease_identity_drift");
      assert.equal(unrelatedHead.write, false);
    }

    const released = revalidateExecutionLease({
      role: "navigator",
      boundary: "integration",
      lease: fixtureLease({ state: "released" }),
      approved: fixtureApproved(),
      observed: {
        candidate_revision: "cafebabe",
        parent_revision: "4040dfe",
      },
    });
    assert.equal(released.ok, false);
    if (!released.ok) {
      assert.equal(released.status, "WAITING_ON");
      assert.equal(released.code, "lease_not_active");
      assert.equal(released.write, false);
    }
  });
});
