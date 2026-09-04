#!/usr/bin/env node
"use strict";

/**
 * Bearing Lite return/closeout adapter (CONTRACT-HOOK-01).
 * Advisory for ordinary handoff reminders; may BLOCK only protected completion.
 * Infrastructure failure fails open as UNAVAILABLE and never fabricates BLOCK.
 */

const HOOK_CLASS = "closeout";
const OUTCOMES = Object.freeze(["ADVISE", "REROUTE", "BLOCK", "UNAVAILABLE"]);
const ENFORCEMENT = "procedural";

const HANDOFF_FIELDS = Object.freeze([
  "verdict",
  "candidate_ref",
  "changed_paths",
  "tests",
  "findings",
  "blocker",
]);

/** Closed role-return tokens. Task-block `outcome` is intent and cannot satisfy this. */
const VERDICT_VALUES = new Set([
  "ACCEPT",
  "ACCEPT_WITH_FINDINGS",
  "BLOCK",
  "CANDIDATE_READY",
  "FAIL",
  "GAPS",
  "NEEDS_MORE_EVIDENCE",
  "OWNER_DECISION_REQUIRED",
  "PARTIAL",
  "PASS",
  "READY",
  "REPAIR_REQUIRED",
  "REROUTED",
  "WAITING_ON",
]);

const RECOVERY_UNAVAILABLE =
  "Report UNAVAILABLE, complete the handoff checklist manually, and do not request protected completion until required fields and assurance are present";
const RECOVERY_HANDOFF =
  "Complete the compact receipt (verdict, candidate_ref, changed_paths, tests, findings, blocker) in the project plan";
const RECOVERY_COMPLETE =
  "Handoff is complete; parent coordinator may advance using the project plan only";
const RECOVERY_BLOCK_COMPLETION =
  "Do not mark COMPLETE; restore missing assurance, candidate match, or handoff fields first. Repair and owner channels remain open";
const RECOVERY_CHANNEL =
  "Keep repair, status, owner communication, and safe rollback available; closeout does not block them";

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

function missingHandoffFields(input) {
  const handoff = isPlainObject(input.handoff) ? input.handoff : input;
  const missing = [];
  for (const field of HANDOFF_FIELDS) {
    const value = handoff[field];
    if (value === undefined || value === null) {
      missing.push(field);
      continue;
    }
    if (typeof value === "string" && value.trim() === "") {
      missing.push(field);
      continue;
    }
    if (field === "verdict" && (typeof value !== "string" || !VERDICT_VALUES.has(value.trim()))) {
      missing.push(field);
    }
  }
  // blocker may be the string "none"; that is present and valid.
  return missing;
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

    const mode =
      input.mode === "protected_completion" || input.protected_completion === true
        ? "protected_completion"
        : "advisory";

    const missing = missingHandoffFields(input);
    const required = normalizeAssurance(input.required_assurance);
    const accepted = Array.isArray(input.assurance_accepted)
      ? input.assurance_accepted.map(String)
      : [];
    const missingAssurance = required.filter((role) => !accepted.includes(role));
    // Protected completion requires explicit same-candidate proof; omit/false fail closed.
    // Advisory closeout never uses this flag for outcome selection.
    const candidateMatched = input.candidate_matched === true;
    const unresolvedBlocker =
      input.unresolved_blocker === true ||
      (typeof input.blocker === "string" &&
        input.blocker.trim() &&
        input.blocker.trim() !== "none");

    if (mode === "protected_completion") {
      const blockers = [];
      if (missing.length > 0) blockers.push("handoff:" + missing.join(","));
      if (missingAssurance.length > 0) {
        blockers.push("assurance:" + missingAssurance.join(","));
      }
      if (!candidateMatched) blockers.push("candidate_mismatch");
      if (unresolvedBlocker) blockers.push("unresolved_blocker");

      if (blockers.length > 0) {
        return result(
          "BLOCK",
          "protected_completion_invalid:" + blockers.join("+"),
          RECOVERY_BLOCK_COMPLETION,
          { protected_action: "completion" }
        );
      }

      return result(
        "ADVISE",
        "protected_completion_ready",
        RECOVERY_COMPLETE,
        { protected_action: "completion" }
      );
    }

    // Advisory closeout: never BLOCK.
    if (missing.length > 0) {
      return result(
        "ADVISE",
        "handoff_incomplete:" + missing.join(","),
        RECOVERY_HANDOFF
      );
    }

    if (missingAssurance.length > 0) {
      return result(
        "ADVISE",
        "assurance_pending:" + missingAssurance.join(","),
        "Do not request protected completion until assurance roles accept the same candidate: " +
          missingAssurance.join(", ")
      );
    }

    return result("ADVISE", "handoff_complete", RECOVERY_COMPLETE);
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
  HANDOFF_FIELDS,
  VERDICT_VALUES,
  evaluate,
};

if (require.main === module) {
  main();
}
