#!/usr/bin/env node
"use strict";

/**
 * Bearing Lite activation/context advisory adapter (CONTRACT-HOOK-01).
 * Advisory only: outcomes are ADVISE or UNAVAILABLE. Never fabricates BLOCK.
 * Skills-only clients: enforcement remains procedural. Claude Code and Codex
 * use the verified partial mapping in hooks/com.anthropic.claude-code/.
 */

const HOOK_CLASS = "activation";
const OUTCOMES = Object.freeze(["ADVISE", "REROUTE", "BLOCK", "UNAVAILABLE"]);
const ENFORCEMENT = "procedural";

const RECOVERY_UNAVAILABLE =
  "Report UNAVAILABLE, invoke the bearing-lite router manually, and continue after context is loaded";
const RECOVERY_ROUTER =
  "Invoke skills/bearing-lite (router), load the assigned role skill, and record the next action in the project plan";
const RECOVERY_CONTINUE =
  "Continue with the assigned role; keep the project plan as the only task record";

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

/**
 * @param {unknown} input
 * @returns {{hook_class:string,outcome:string,reason:string,recovery:string,enforcement:string,protected_action?:string}}
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
      const kind = String(input.infrastructure_failure);
      return unavailable(kind || "infrastructure_failure");
    }

    // Safe channels must remain reachable; advisory never blocks them.
    const channel = input.channel;
    if (
      channel === "repair" ||
      channel === "status" ||
      channel === "owner_communication" ||
      channel === "safe_rollback"
    ) {
      return result(
        "ADVISE",
        "channel_open",
        "Keep repair, status, owner communication, and safe rollback available"
      );
    }

    const planPresent = input.plan_present === true;
    const nextActionKnown =
      input.next_action_known === true ||
      (typeof input.next_action === "string" && input.next_action.trim().length > 0);
    const role =
      typeof input.assigned_role === "string" && input.assigned_role.trim()
        ? input.assigned_role.trim()
        : null;
    const routerInvoked = input.router_invoked === true;
    const missingStages = Array.isArray(input.missing_planning_stages)
      ? input.missing_planning_stages.filter((s) => typeof s === "string" && s.trim())
      : [];

    if (!planPresent || !nextActionKnown || !role || !routerInvoked || missingStages.length > 0) {
      const gaps = [];
      if (!planPresent) gaps.push("plan");
      if (!nextActionKnown) gaps.push("next_action");
      if (!role) gaps.push("assigned_role");
      if (!routerInvoked) gaps.push("router");
      if (missingStages.length > 0) gaps.push("planning_stages:" + missingStages.join(","));
      return result("ADVISE", "context_incomplete:" + gaps.join("+"), RECOVERY_ROUTER);
    }

    return result("ADVISE", "context_ready", RECOVERY_CONTINUE);
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

  const out = evaluate(parsed);
  process.stdout.write(JSON.stringify(out) + "\n");
  // Always exit 0: never map policy or infrastructure to process status (RISK-12 / RISK-20).
  process.exit(0);
}

module.exports = {
  HOOK_CLASS,
  OUTCOMES,
  ENFORCEMENT,
  evaluate,
};

if (require.main === module) {
  main();
}
