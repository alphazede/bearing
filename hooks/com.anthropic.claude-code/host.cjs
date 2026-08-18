#!/usr/bin/env node
"use strict";

/**
 * Verified host adapter (CONTRACT-HOOK-01, CONTRACT-CLIENT-01).
 *
 * Claude Code, Codex, Grok Build, Cursor, and Kimi Code deliver session
 * events. This adapter derives only the Bearing fields that are visible in
 * the project plan, then calls the portable class evaluators. It never
 * fabricates BLOCK from a missing field.
 *
 * Coverage is partial: activation and closeout are executable; transition and
 * protected_action stay procedural. Always exit 0 (RISK-12 / RISK-20). Host
 * blocking, if ever required, is JSON-only — never process status.
 */

const fs = require("node:fs");
const path = require("node:path");

const activation = require("../activation.cjs");
const closeout = require("../closeout.cjs");

const HOST = "com.anthropic.claude-code";
const COVERAGE = Object.freeze({
  activation: Object.freeze({ executable: true, procedural: true }),
  closeout: Object.freeze({ executable: true, procedural: true }),
  transition: Object.freeze({ executable: false, procedural: true }),
  protected_action: Object.freeze({ executable: false, procedural: true }),
});

const MAX_FILES = 20;
const MAX_BYTES = 256 * 1024;
const MAX_DEPTH = 3;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".next",
  ".cache",
  "target",
  "vendor",
  ".venv",
  "venv",
  "skills",
  "hooks",
  "test",
  "tests",
  "templates",
]);

const TASK_MARK = /(?:^|\n)###\s*task_id:\s*\S+/;
const TASK_LINE = /^###\s*task_id:\s*(\S+)\s*$/;
const FIELD_LINE =
  /^-\s*(assigned_role|next_action|status|required_assurance|blocker|evidence|candidate_ref|scope|authority|outcome|depends_on|receiving_role|plan_ref|role|subject):\s*(.*)$/;
const JOURNEY_LINE = /^\s*-\s*journey:\s*(.+)$/i;
const LEASE_MARK = /^\s*-\s*checkout_lease:/m;

const ACTIVATION_EVENTS = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "CwdChanged",
  "SubagentStart",
]);
const CLOSEOUT_EVENTS = new Set(["Stop", "SubagentStop", "SessionEnd"]);
const STOP_CONTINUATION_EVENTS = new Set(["Stop", "SubagentStop"]);

const EVENT_ALIASES = Object.freeze({
  sessionstart: "SessionStart",
  userpromptsubmit: "UserPromptSubmit",
  beforesubmitprompt: "UserPromptSubmit",
  userpromptexpansion: "UserPromptExpansion",
  cwdchanged: "CwdChanged",
  subagentstart: "SubagentStart",
  stop: "Stop",
  subagentstop: "SubagentStop",
  sessionend: "SessionEnd",
  pretooluse: "PreToolUse",
  posttooluse: "PostToolUse",
  beforeshellexecution: "PreToolUse",
  afterfileedit: "PostToolUse",
});

/**
 * Normalize Claude, Codex, Grok, Cursor, and Kimi event names.
 * @param {unknown} name
 */
function canonicalizeEvent(name) {
  if (typeof name !== "string" || !name.trim()) return "";
  const compact = name.trim().replace(/[_-]/g, "").toLowerCase();
  return EVENT_ALIASES[compact] || name.trim();
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlaceholder(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "unassigned" || /^<[^>]+>$/.test(trimmed);
}

function presentString(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || isPlaceholder(trimmed)) return undefined;
  return trimmed;
}

function readStdinSync() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch (err) {
    const code = err && err.code;
    if (code === "EAGAIN" || code === "EOF") return "";
    throw err;
  }
}

function rankMarkdown(name) {
  const n = name.toLowerCase();
  if (n === "plan.md" || n === "progress.md") return 0;
  if (n.includes("plan")) return 1;
  if (n.includes("implementation") || n.includes("progress")) return 2;
  return 5;
}

function walkMarkdown(root) {
  const out = [];
  function walk(dir, depth) {
    if (out.length >= MAX_FILES || depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files = [];
    const dirs = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".") && entry.name !== ".agents") continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) dirs.push(entry.name);
      } else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) {
        files.push(entry.name);
      }
    }
    files.sort((a, b) => rankMarkdown(a) - rankMarkdown(b) || a.localeCompare(b));
    for (const name of files) {
      if (out.length >= MAX_FILES) return;
      out.push(path.join(dir, name));
    }
    dirs.sort((a, b) => {
      if (a === "docs") return -1;
      if (b === "docs") return 1;
      if (a === "plans") return -1;
      if (b === "plans") return 1;
      return a.localeCompare(b);
    });
    for (const name of dirs) {
      walk(path.join(dir, name), depth + 1);
    }
  }
  walk(root, 0);
  return out;
}

function parsePlanMarkdown(text) {
  const tasks = [];
  let journey = null;
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    const journeyMatch = line.match(JOURNEY_LINE);
    if (journeyMatch) {
      const value = presentString(journeyMatch[1]);
      if (value) journey = value;
    }
    const taskMatch = line.match(TASK_LINE);
    if (taskMatch) {
      if (current) tasks.push(current);
      current = { task_id: taskMatch[1] };
      continue;
    }
    if (!current) continue;
    const fieldMatch = line.match(FIELD_LINE);
    if (fieldMatch) {
      const value = presentString(fieldMatch[2]);
      if (value !== undefined) current[fieldMatch[1]] = value;
    }
  }
  if (current) tasks.push(current);
  return { tasks, journey };
}

/**
 * Derive Bearing domain fields from visible Markdown in cwd.
 * Does not invent router_invoked, assigned_role, or next_action.
 * @param {string} cwd
 */
function deriveContext(cwd) {
  const files = walkMarkdown(cwd);
  const allTasks = [];
  let journey = null;
  let planPresent = false;
  for (const file of files) {
    let text;
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > MAX_BYTES) continue;
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const parsed = parsePlanMarkdown(text);
    const hasAssignedRole = /^-\s*assigned_role:/m.test(text);
    const hasLease = LEASE_MARK.test(text);
    if (!TASK_MARK.test(text) && !hasAssignedRole && !parsed.journey && !hasLease) {
      continue;
    }
    planPresent = true;
    if (parsed.journey) journey = parsed.journey;
    for (const task of parsed.tasks) allTasks.push(task);
  }

  const active =
    allTasks.find((task) => {
      const status = presentString(task.status);
      return status && status !== "COMPLETE" && status !== "CANCELLED";
    }) ||
    allTasks[0] ||
    null;

  const assignedRole = active ? presentString(active.assigned_role) : undefined;
  const nextAction = active ? presentString(active.next_action) : undefined;

  return {
    plan_present: planPresent,
    router_invoked: Boolean(journey),
    assigned_role: assignedRole,
    next_action: nextAction,
    next_action_known: Boolean(nextAction),
    active_task: active,
    journey,
  };
}

function classForEvent(eventName) {
  const canonical = canonicalizeEvent(eventName);
  if (ACTIVATION_EVENTS.has(canonical)) return "activation";
  if (CLOSEOUT_EVENTS.has(canonical)) return "closeout";
  return null;
}

function isTruthyFlag(value) {
  return value === true || value === "true";
}

function isStopReentry(input, eventName) {
  if (!STOP_CONTINUATION_EVENTS.has(eventName)) return false;
  return isTruthyFlag(input.stop_hook_active) || isTruthyFlag(input.stopHookActive);
}

function hasDiscoverableJourney(derived) {
  return (
    derived.plan_present === true ||
    derived.router_invoked === true ||
    Boolean(derived.assigned_role) ||
    derived.active_task != null
  );
}

function quietSuccess() {
  return {};
}

function formatAdvice(verdict) {
  const lines = [
    "Bearing Lite " + verdict.hook_class + ": " + verdict.outcome,
    verdict.reason ? "reason: " + verdict.reason : "",
    verdict.recovery ? "recovery: " + verdict.recovery : "",
    "Coverage: this host mapping is partial. activation and closeout are executable; transition and protected_action remain procedural.",
  ].filter(Boolean);
  return lines.join("\n").slice(0, 4000);
}

function unavailableHost(eventName, reason) {
  const event = eventName || "SessionStart";
  return {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext:
        "Bearing Lite UNAVAILABLE: " +
        reason +
        ". Invoke the bearing-lite router manually and continue after context is loaded.",
    },
  };
}

/**
 * Translate a portable verdict into Claude Code / Codex JSON.
 * Exit status is never used for policy (RISK-12 / RISK-20).
 */
function toHostResponse(eventName, verdict) {
  const event = eventName || "SessionStart";
  const text = formatAdvice(verdict);
  const body = {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: text,
    },
  };
  // This mapping never requests protected_completion, so BLOCK should not
  // appear. If a future caller passes a BLOCK verdict, use JSON only.
  if (verdict.outcome === "BLOCK") {
    body.decision = "block";
    body.reason = text;
  }
  return body;
}

function evaluateForHost(eventName, derived) {
  if (classForEvent(eventName) === "closeout") {
    const task = derived.active_task || {};
    return closeout.evaluate({
      plan_ref: derived.plan_present ? "project-plan" : undefined,
      role: presentString(task.assigned_role) || presentString(task.role),
      subject: presentString(task.task_id) || presentString(task.subject),
      depends_on: task.depends_on,
      scope: presentString(task.scope),
      authority: presentString(task.authority),
      outcome: presentString(task.outcome),
      evidence: presentString(task.evidence),
      blocker: presentString(task.blocker) || "none",
      next_action: presentString(task.next_action),
      receiving_role: presentString(task.receiving_role),
      required_assurance: task.required_assurance,
    });
  }
  return activation.evaluate({
    plan_present: derived.plan_present === true,
    next_action_known: derived.next_action_known === true,
    next_action: derived.next_action,
    assigned_role: derived.assigned_role,
    router_invoked: derived.router_invoked === true,
  });
}

/**
 * @param {unknown} input
 */
function handle(input) {
  let parsed = input;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return unavailableHost("SessionStart", "malformed_input");
    }
  }
  if (parsed === undefined || parsed === null) {
    return unavailableHost("SessionStart", "missing_input");
  }
  if (!isPlainObject(parsed)) {
    return unavailableHost("SessionStart", "malformed_input");
  }

  const eventName = canonicalizeEvent(
    parsed.hook_event_name || parsed.hookEventName
  );
  if (!classForEvent(eventName)) {
    return unavailableHost(eventName || "SessionStart", "unmapped_host_event");
  }

  if (isStopReentry(parsed, eventName)) {
    return quietSuccess();
  }

  const cwd =
    presentString(parsed.cwd) ||
    presentString(parsed.workspaceRoot) ||
    process.cwd();

  let derived;
  try {
    derived = deriveContext(cwd);
  } catch {
    return toHostResponse(
      eventName,
      activation.evaluate({ infrastructure_failure: "permission_error" })
    );
  }

  if (STOP_CONTINUATION_EVENTS.has(eventName) && !hasDiscoverableJourney(derived)) {
    return quietSuccess();
  }

  return toHostResponse(eventName, evaluateForHost(eventName, derived));
}

function main() {
  let raw = "";
  try {
    raw = readStdinSync();
  } catch {
    process.stdout.write(JSON.stringify(unavailableHost("SessionStart", "stdin_read_failure")) + "\n");
    process.exit(0);
    return;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    process.stdout.write(JSON.stringify(unavailableHost("SessionStart", "missing_input")) + "\n");
    process.exit(0);
    return;
  }

  process.stdout.write(JSON.stringify(handle(trimmed)) + "\n");
  process.exit(0);
}

module.exports = {
  HOST,
  COVERAGE,
  canonicalizeEvent,
  classForEvent,
  deriveContext,
  evaluateForHost,
  handle,
  toHostResponse,
};

if (require.main === module) {
  main();
}
