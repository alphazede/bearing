/**
 * CMD-ROUTING-01 / SEIT-ROUTING-01
 * Direct, Explorer-owned wave, Expedition, delegated routes; dormancy negatives.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

/** @typedef {'crewmate'|'explorer'|'navigator'|'trail-boss'|'sub-explorer'|'delegate-authority'|'validator'|'park-ranger'|'surveyor'} Role */

/**
 * @typedef {{
 *   kind: 'direct' | 'explorer_wave' | 'expedition' | 'delegated',
 *   packetCount?: number,
 *   multiWaveConflict?: boolean,
 *   nestedLanes?: number,
 *   ownerDelegatedMultiPhase?: boolean,
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
  "trail-boss",
  "sub-explorer",
  "delegate-authority",
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
      message: "Single packet must not force Navigator/Trail Boss/Delegate controllers",
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
    if (input.multiWaveConflict) active.push("trail-boss");
    if ((input.nestedLanes ?? 0) >= 2) active.push("sub-explorer");
  } else if (input.kind === "delegated") {
    if (!input.ownerDelegatedMultiPhase) {
      return {
        ok: false,
        code: "delegation_without_owner",
        message: "Delegate Authority requires explicit owner multi-phase delegation",
      };
    }
    active.push("delegate-authority", "navigator", "explorer", "crewmate");
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
  const coordinators = active.filter((r) =>
    ["explorer", "navigator", "trail-boss", "sub-explorer", "delegate-authority"].includes(r)
  );
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
      assert.ok(verdict.dormant.includes("delegate-authority"));
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
      assert.ok(verdict.dormant.includes("trail-boss"));
      assert.ok(verdict.dormant.includes("delegate-authority"));
    }
  });

  it("Expedition: Navigator sequencing with optional Trail Boss / Sub-explorer", () => {
    const simple = selectRoute({ kind: "expedition", packetCount: 4 });
    assert.equal(simple.ok, true);
    if (simple.ok) {
      assert.ok(simple.active.includes("navigator"));
      assert.ok(simple.active.includes("explorer"));
      assert.ok(simple.active.includes("crewmate"));
      assert.ok(!simple.active.includes("trail-boss"));
    }
    const conflicted = selectRoute({
      kind: "expedition",
      multiWaveConflict: true,
      nestedLanes: 2,
    });
    assert.equal(conflicted.ok, true);
    if (conflicted.ok) {
      assert.ok(conflicted.active.includes("trail-boss"));
      assert.ok(conflicted.active.includes("sub-explorer"));
    }
  });

  it("Delegated: Delegate Authority when owner multi-phase delegation is explicit", () => {
    const verdict = selectRoute({
      kind: "delegated",
      ownerDelegatedMultiPhase: true,
    });
    assert.equal(verdict.ok, true);
    if (verdict.ok) {
      assert.ok(verdict.active.includes("delegate-authority"));
      assert.ok(verdict.active.includes("navigator"));
      assert.ok(verdict.active.includes("crewmate"));
    }
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
