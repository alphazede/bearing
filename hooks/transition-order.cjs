#!/usr/bin/env node
"use strict";

/**
 * Bearing Lite transition-order integrity adapter (CONTRACT-HOOK-01).
 * Reroutes missing prerequisites; BLOCKs only explicit positive sequence violations.
 * Never fabricates BLOCK from infrastructure failure. Safe channels stay open.
 */

const HOOK_CLASS = "transition";
const OUTCOMES = Object.freeze(["ADVISE", "REROUTE", "BLOCK", "UNAVAILABLE"]);
const ENFORCEMENT = "procedural";

const RECOVERY_UNAVAILABLE =
  "Keep the current state, run the transition checklist procedurally, and record the result before retrying";
const RECOVERY_ALLOW =
  "Proceed with the requested transition and update the project plan as the only task record";
const RECOVERY_CHANNEL =
  "Keep repair, status, owner communication, and safe rollback available; do not treat them as sequence violations";

/** Legal directed edges from CONTRACT-STATE-01 / task-state text. */
const LEGAL = Object.freeze({
  PROPOSED: ["READY", "WAITING_ON"],
  READY: ["IN_PROGRESS", "OWNER_DECISION_REQUIRED"],
  WAITING_ON: ["READY", "EVIDENCE_READY", "CANCELLED"],
  IN_PROGRESS: ["EVIDENCE_READY", "CORRECTION_REQUIRED", "OWNER_DECISION_REQUIRED"],
  EVIDENCE_READY: [
    "VALIDATING",
    "REVIEWING",
    "ACCEPTANCE",
    "WAITING_ON",
  ],
  VALIDATING: ["EVIDENCE_READY", "CORRECTION_REQUIRED"],
  REVIEWING: ["EVIDENCE_READY", "CORRECTION_REQUIRED", "OWNER_DECISION_REQUIRED"],
  ACCEPTANCE: ["COMPLETE", "CORRECTION_REQUIRED"],
  CORRECTION_REQUIRED: ["READY", "OWNER_DECISION_REQUIRED"],
  OWNER_DECISION_REQUIRED: ["READY", "CANCELLED"],
  COMPLETE: [],
  CANCELLED: [],
});

const SAFE_CHANNELS = new Set([
  "repair",
  "status",
  "owner_communication",
  "safe_rollback",
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function result(outcome, reason, recovery, extra) {
  const body = {
    hook_class: HOOK_CLASS,
    outcome,
    reason,
    recovery,
    enforcement: ENFORCEMENT,
  };
  if (extra && typeof extra.protected_action === "string" && extra.protected_action) {
    body.protected_action = extra.protected_action;
  }
  return body;
}

function unavailable(reason) {
  return result("UNAVAILABLE", reason, RECOVERY_UNAVAILABLE);
}

function normalizeAssurance(value) {
  if (value === undefined || value === null || value === "" || value === "none") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map(String).filter((s) => s && s !== "none");
  }
  return [String(value)].filter((s) => s && s !== "none");
}

/** Normalize role labels for order comparison (Validator vs validator vs park-ranger). */
function normalizeRoleKey(role) {
  return String(role)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

/**
 * Map the next missing assurance role to the state that should receive it.
 * Validator -> VALIDATING, Park Ranger -> REVIEWING, Surveyor -> ACCEPTANCE.
 */
function assuranceTargetState(role) {
  const key = normalizeRoleKey(role);
  if (key === "validator") return "VALIDATING";
  if (key === "park-ranger" || key === "parkranger") return "REVIEWING";
  if (key === "surveyor") return "ACCEPTANCE";
  return null;
}

/**
 * @param {unknown} input
 */
function evaluate(input) {
  try {
    if (input === undefined || input === null) {
      return unavailable("missing_input");
    }
    if (typeof input === "string") {
      try {
        input = JSON.parse(input);
      } catch {
        return unavailable("malformed_input");
      }
    }
    if (!isPlainObject(input)) {
      return unavailable("malformed_input");
    }

    if (input.infrastructure_failure) {
      return unavailable(String(input.infrastructure_failure) || "infrastructure_failure");
    }

    if (SAFE_CHANNELS.has(input.channel) || SAFE_CHANNELS.has(input.action_kind)) {
      return result("ADVISE", "channel_open", RECOVERY_CHANNEL);
    }

    const from = typeof input.from_state === "string" ? input.from_state.trim() : "";
    const to = typeof input.to_state === "string" ? input.to_state.trim() : "";
    if (!from || !to) {
      return unavailable("malformed_input");
    }
    if (!Object.prototype.hasOwnProperty.call(LEGAL, from)) {
      return unavailable("unknown_from_state");
    }

    const legalTargets = LEGAL[from] || [];
    const required = normalizeAssurance(input.required_assurance);
    const completed = Array.isArray(input.assurance_completed)
      ? input.assurance_completed.map(String)
      : [];
    const missingAssurance = required.filter((role) => !completed.includes(role));
    const prerequisitesMet = input.prerequisites_met !== false;
    const explicitSkip = input.skip_required_step === true;
    const afterReroute = input.after_reroute === true;
    const invalidatesDependents = input.invalidates_dependents === true;

    // Hard block only for explicit positive violations (DEC-HOOK-03 / DEC-HOOK-02).
    if (explicitSkip && afterReroute) {
      return result(
        "BLOCK",
        "required_step_skipped_after_reroute",
        "Stop the invalid transition; reroute remains recorded; restore the missing step before retrying",
        { protected_action: "transition:" + from + "->" + to }
      );
    }

    if (explicitSkip && invalidatesDependents) {
      return result(
        "BLOCK",
        "sequence_violation_invalidates_dependents",
        "Stop the transition that would invalidate dependents; repair the sequence before retrying",
        { protected_action: "transition:" + from + "->" + to }
      );
    }

    if (!legalTargets.includes(to)) {
      return result(
        "REROUTE",
        "illegal_transition:" + from + "->" + to,
        "Return to a legal edge from " + from + "; do not invent a state jump"
      );
    }

    if (!prerequisitesMet) {
      const missing =
        typeof input.missing_step === "string" && input.missing_step.trim()
          ? input.missing_step.trim()
          : "prerequisite";
      return result(
        "REROUTE",
        "missing_prerequisite:" + missing,
        "Perform missing step `" + missing + "` and record evidence before retrying " + from + "->" + to
      );
    }

    // Completing while required assurance is still open.
    if (to === "COMPLETE" && missingAssurance.length > 0) {
      if (explicitSkip) {
        return result(
          "BLOCK",
          "required_assurance_skipped:" + missingAssurance.join(","),
          "Complete required assurance roles before protected completion",
          { protected_action: "transition:ACCEPTANCE->COMPLETE" }
        );
      }
      return result(
        "REROUTE",
        "required_assurance_pending:" + missingAssurance.join(","),
        "Dispatch the next missing assurance role: " + missingAssurance[0]
      );
    }

    // Assurance order: only the next missing role's state is allowed.
    // E.g. Validator done, Park Ranger pending -> REVIEWING allowed, ACCEPTANCE reroutes.
    if (
      missingAssurance.length > 0 &&
      (to === "VALIDATING" || to === "REVIEWING" || to === "ACCEPTANCE")
    ) {
      const nextRole = missingAssurance[0];
      const expectedTo = assuranceTargetState(nextRole);
      if (!expectedTo || to !== expectedTo) {
        return result(
          "REROUTE",
          "assurance_order:" + nextRole,
          "Run assurance in declared order; next required role is " + nextRole
        );
      }
    }

    if (explicitSkip) {
      // First detection: reroute before hard block.
      const step =
        typeof input.missing_step === "string" && input.missing_step.trim()
          ? input.missing_step.trim()
          : missingAssurance[0] || "required_step";
      return result(
        "REROUTE",
        "required_step_skipped:" + step,
        "Reroute to missing step `" + step + "`; hard block only after a repeated skip"
      );
    }

    return result("ADVISE", "transition_allowed:" + from + "->" + to, RECOVERY_ALLOW);
  } catch {
    return unavailable("adapter_exception");
  }
}

function readStdinSync() {
  try {
    return require("node:fs").readFileSync(0, "utf8");
  } catch (err) {
    const code = err && err.code;
    if (code === "EAGAIN" || code === "EOF") return "";
    throw err;
  }
}

function main() {
  let raw = "";
  try {
    raw = readStdinSync();
  } catch {
    process.stdout.write(JSON.stringify(unavailable("stdin_read_failure")) + "\n");
    process.exit(0);
    return;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    process.stdout.write(JSON.stringify(unavailable("missing_input")) + "\n");
    process.exit(0);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    process.stdout.write(JSON.stringify(unavailable("malformed_input")) + "\n");
    process.exit(0);
    return;
  }

  process.stdout.write(JSON.stringify(evaluate(parsed)) + "\n");
  process.exit(0);
}

module.exports = {
  HOOK_CLASS,
  OUTCOMES,
  ENFORCEMENT,
  LEGAL,
  evaluate,
};

if (require.main === module) {
  main();
}
