#!/usr/bin/env node
"use strict";

/**
 * Bearing Lite protected-action integrity adapter (CONTRACT-HOOK-01).
 * BLOCKs only explicit positive protected-action violations.
 * Repair, status, owner communication, and safe rollback remain reachable.
 * Infrastructure failure never becomes BLOCK or implicit permission.
 */

const HOOK_CLASS = "protected_action";
const OUTCOMES = Object.freeze(["ADVISE", "REROUTE", "BLOCK", "UNAVAILABLE"]);
const ENFORCEMENT = "procedural";

const RECOVERY_UNAVAILABLE =
  "Keep the action pending; obtain normal owner approval when owner-only, otherwise complete the equivalent procedural integrity check before retrying";
const RECOVERY_ALLOW =
  "Proceed only within declared authority; leave the project plan as the only task record";
const RECOVERY_CHANNEL =
  "Keep repair, status, owner communication, and safe rollback available while the protected action stays pending";
const RECOVERY_OWNER =
  "Route to OWNER_DECISION_REQUIRED with evidence, blocker, and the smallest owner choices; do not expand authority";

const SAFE_CHANNELS = new Set([
  "repair",
  "status",
  "owner_communication",
  "safe_rollback",
]);

/** Explicit positive violation categories (design hard-block list). */
const VIOLATION_KEYS = Object.freeze([
  "owner_authority_violation",
  "destructive_public_without_authority",
  "secret_exposure",
  "repository_ambiguous",
  "evidence_dishonest",
]);

/**
 * Owner authorization may waive only authority-dependent actions.
 * Secret exposure, dishonest evidence, and repository ambiguity are never waivable.
 */
const WAIVABLE_VIOLATIONS = new Set([
  "owner_authority_violation",
  "destructive_public_without_authority",
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

function actionId(input) {
  if (typeof input.protected_action === "string" && input.protected_action.trim()) {
    return input.protected_action.trim();
  }
  if (typeof input.action === "string" && input.action.trim()) {
    return input.action.trim();
  }
  return "protected_action";
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

    // Never block the communication path needed to resolve a finding.
    if (SAFE_CHANNELS.has(input.channel) || SAFE_CHANNELS.has(input.action_kind)) {
      return result("ADVISE", "channel_open", RECOVERY_CHANNEL);
    }

    const id = actionId(input);
    const ownerAuthorized = input.owner_authorized === true;

    // Collect only explicit positive violation flags (truthy booleans or listed categories).
    const categories = Array.isArray(input.violation_categories)
      ? input.violation_categories.map(String)
      : [];
    const hits = [];

    for (const key of VIOLATION_KEYS) {
      if (input[key] === true || categories.includes(key)) {
        hits.push(key);
      }
    }

    // Generic explicit_violation requires a named category; bare true alone is not enough
    // to invent a security finding.
    if (input.explicit_violation === true && hits.length === 0) {
      if (typeof input.reason_code === "string" && input.reason_code.trim()) {
        hits.push(input.reason_code.trim());
      }
    }

    if (hits.length > 0) {
      const nonWaivable = hits.filter((h) => !WAIVABLE_VIOLATIONS.has(h));
      if (nonWaivable.length > 0) {
        // Non-waivable integrity findings always hard-block, even with owner_authorized.
        return result(
          "BLOCK",
          "protected_violation:" + nonWaivable.join("+"),
          RECOVERY_OWNER,
          { protected_action: id }
        );
      }
      if (!ownerAuthorized) {
        return result(
          "BLOCK",
          "protected_violation:" + hits.join("+"),
          RECOVERY_OWNER,
          { protected_action: id }
        );
      }
      // All hits are authority-dependent and explicitly owner-authorized.
      return result(
        "ADVISE",
        "owner_authorized:" + hits.join("+"),
        RECOVERY_ALLOW,
        { protected_action: id }
      );
    }

    // Owner-only action declared without owner confirmation: keep pending (not a fabricated block
    // unless a positive violation flag is set). Report REROUTE to owner when marked owner_only.
    if (input.owner_only === true && !ownerAuthorized) {
      return result(
        "REROUTE",
        "owner_confirmation_required",
        RECOVERY_OWNER,
        { protected_action: id }
      );
    }

    return result("ADVISE", "protected_action_clear", RECOVERY_ALLOW, {
      protected_action: id,
    });
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
  VIOLATION_KEYS,
  evaluate,
};

if (require.main === module) {
  main();
}
