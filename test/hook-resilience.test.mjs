/**
 * CMD-HOOK-FAILURE-01 / SEIT-HOOK-FAILURE-01
 * Infrastructure failures surface UNAVAILABLE; never fabricate policy BLOCK.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const activation = require(path.join(ROOT, "hooks/activation.cjs"));
const closeout = require(path.join(ROOT, "hooks/closeout.cjs"));
const transition = require(path.join(ROOT, "hooks/transition-order.cjs"));
const protectedAction = require(path.join(ROOT, "hooks/protected-action.cjs"));

const ALL = [
  ["activation", activation],
  ["closeout", closeout],
  ["transition", transition],
  ["protected_action", protectedAction],
];

const INFRA_FAILURES = [
  "missing_target",
  "missing_adapter",
  "missing_interpreter",
  "permission_error",
  "timeout",
  "malformed_output",
  "duplicate_firing",
  "reserved_exit_collision",
];

const SAFE_CHANNELS = ["repair", "status", "owner_communication", "safe_rollback"];

/**
 * Simulate host-side infrastructure failure mapping.
 * Policy: never convert infra failure into BLOCK.
 * @param {{ evaluate: Function }} hook
 * @param {string} kind
 */
export function evaluateInfrastructureFailure(hook, kind) {
  return hook.evaluate({ infrastructure_failure: kind });
}

/**
 * Simulate malformed host wrapping that still must not invent BLOCK.
 * @param {{ evaluate: Function }} hook
 * @param {unknown} raw
 */
export function evaluateMalformed(hook, raw) {
  return hook.evaluate(raw);
}

describe("CMD-HOOK-FAILURE-01 hook-resilience (SEIT-HOOK-FAILURE-01)", () => {
  for (const [name, hook] of ALL) {
    describe(`${name} infrastructure matrix`, () => {
      for (const kind of INFRA_FAILURES) {
        it(`${kind} → UNAVAILABLE (never policy BLOCK)`, () => {
          const result = evaluateInfrastructureFailure(hook, kind);
          assert.equal(result.outcome, "UNAVAILABLE", JSON.stringify(result));
          assert.notEqual(result.outcome, "BLOCK");
          assert.ok(result.reason, "reason required");
          assert.ok(result.recovery, "recovery guidance required");
        });
      }

      it("malformed output / missing input → UNAVAILABLE", () => {
        for (const raw of [null, undefined, "", "{not-json", 42, ["array"]]) {
          const result = evaluateMalformed(hook, raw);
          assert.equal(
            result.outcome,
            "UNAVAILABLE",
            `${name} raw=${JSON.stringify(raw)} => ${JSON.stringify(result)}`
          );
          assert.notEqual(result.outcome, "BLOCK");
        }
      });

      it("safe channels remain usable under failure-adjacent inputs", () => {
        for (const channel of SAFE_CHANNELS) {
          const result = hook.evaluate({
            channel,
            // Even if a host also tags infra noise, channel path is tested cleanly first.
          });
          assert.equal(result.outcome, "ADVISE", `${name} ${channel}`);
          assert.match(String(result.reason), /channel_open/);
        }
      });
    });
  }

  it("duplicate firing still reports UNAVAILABLE without escalating to BLOCK", () => {
    const first = activation.evaluate({ infrastructure_failure: "duplicate_firing" });
    const second = activation.evaluate({ infrastructure_failure: "duplicate_firing" });
    assert.equal(first.outcome, "UNAVAILABLE");
    assert.equal(second.outcome, "UNAVAILABLE");
  });

  it("reserved-exit collision is infrastructure UNAVAILABLE, not fabricated policy BLOCK", () => {
    for (const [, hook] of ALL) {
      const result = hook.evaluate({ infrastructure_failure: "reserved_exit_collision" });
      assert.equal(result.outcome, "UNAVAILABLE");
      assert.notEqual(result.outcome, "BLOCK");
    }
  });

  it("prompt/repair/owner channels remain usable across all classes", () => {
    for (const [name, hook] of ALL) {
      for (const channel of SAFE_CHANNELS) {
        const result = hook.evaluate({ channel, action_kind: channel });
        assert.equal(result.outcome, "ADVISE", `${name}/${channel}`);
      }
    }
  });

  it("negative observable: infra failure must not be treated as BLOCK by consumers", () => {
    // Explicit assertion path: a consumer that maps UNAVAILABLE→BLOCK is the failure mode.
    for (const [, hook] of ALL) {
      const result = hook.evaluate({ infrastructure_failure: "timeout" });
      assert.equal(result.outcome, "UNAVAILABLE");
      const fabricatedBlock = result.outcome === "BLOCK";
      assert.equal(fabricatedBlock, false, "must not fabricate policy BLOCK from timeout");
    }
  });
});
