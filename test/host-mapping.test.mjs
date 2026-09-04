/**
 * Verified Claude Code / Codex host mapping.
 * Derives Bearing fields from cwd Markdown; translates outcomes to host JSON;
 * never maps policy to process status.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const host = require(path.join(ROOT, "hooks/com.anthropic.claude-code/host.cjs"));
const HOST_BIN = path.join(ROOT, "hooks/com.anthropic.claude-code/host.cjs");

const READY_PLAN = `# Journey

- journey: Explorer Journey
- review_cadence: at-end

### task_id: T1
- outcome: add host mapping
- status: IN_PROGRESS
- assigned_role: crewmate
- depends_on: []
- next_action: write host adapter
- scope: hooks/
- authority: S7
- required_assurance: none
`;

const INCOMPLETE_PLAN = `# Notes

### task_id: T9
- outcome: still proposing
- status: PROPOSED
- assigned_role: unassigned
- depends_on: []
- next_action: <smallest concrete next step>
`;

const COMPLETE_PLAN = `# Journey

- journey: Explorer Journey
- review_cadence: at-end

### task_id: T1
- outcome: add host mapping
- status: IN_PROGRESS
- assigned_role: crewmate
- depends_on: []
- next_action: confirm closeout
- scope: hooks/
- authority: S7
- required_assurance: none
- candidate_ref: cand-host
- changed_paths: hooks/
- tests: host-mapping tests
- findings: none
- verdict: PASS
- blocker: none
`;

const INTENT_AS_RECEIPT_PLAN = `# Journey

- journey: Explorer Journey
- review_cadence: at-end

### task_id: T1
- outcome: add host mapping
- status: IN_PROGRESS
- assigned_role: crewmate
- depends_on: []
- next_action: confirm closeout
- scope: hooks/
- authority: S7
- required_assurance: none
- candidate_ref: cand-host
- changed_paths: hooks/
- tests: host-mapping tests
- findings: none
- blocker: none
`;

function assertQuietSuccess(response) {
  assert.notEqual(response.decision, "block");
  assert.equal(response.reason, undefined);
  const serialized = JSON.stringify(response);
  assert.doesNotMatch(serialized, /additionalContext/);
  assert.doesNotMatch(serialized, /handoff_incomplete/);
  assert.doesNotMatch(serialized, /"decision"\s*:\s*"block"/);
}

function writePlan(dir, markdown, filename = "PLAN.md") {
  writeFileSync(path.join(dir, filename), markdown);
}

function runHost(payload) {
  return spawnSync(process.execPath, [HOST_BIN], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe("verified host mapping", () => {
  /** @type {string} */
  let tmp;

  before(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "bearing-lite-host-"));
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("ships hooks.json for SessionStart and Stop only", () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "hooks/hooks.json"), "utf8"));
    assert.deepEqual(Object.keys(manifest.hooks).sort(), ["SessionStart", "Stop"]);
    assert.ok(!manifest.hooks.PreToolUse);
    assert.ok(!manifest.hooks.PostToolUse);
    const command = manifest.hooks.SessionStart[0].hooks[0];
    assert.equal(command.type, "command");
    assert.equal(command.command, "node");
    assert.deepEqual(command.args, [
      "${CLAUDE_PLUGIN_ROOT}/hooks/com.anthropic.claude-code/host.cjs",
    ]);
  });

  it("maps host events to activation or closeout only", () => {
    assert.equal(host.classForEvent("SessionStart"), "activation");
    assert.equal(host.classForEvent("sessionStart"), "activation");
    assert.equal(host.classForEvent("session_start"), "activation");
    assert.equal(host.classForEvent("Stop"), "closeout");
    assert.equal(host.classForEvent("stop"), "closeout");
    assert.equal(host.classForEvent("PreToolUse"), null);
    assert.equal(host.classForEvent("PostToolUse"), null);
  });

  it("accepts Grok/Cursor camelCase session envelopes", () => {
    const cwd = path.join(tmp, "camel");
    mkdirSync(cwd);
    writePlan(cwd, READY_PLAN);
    const response = host.handle({
      sessionId: "s-camel",
      hookEventName: "sessionStart",
      cwd,
      workspaceRoot: cwd,
    });
    assert.equal(response.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(response.hookSpecificOutput.additionalContext, /context_ready/);
  });

  it("ships Cursor camelCase hooks without PreToolUse", () => {
    const cursorHooks = JSON.parse(
      readFileSync(path.join(ROOT, "hooks/com.cursor/hooks.json"), "utf8")
    );
    assert.deepEqual(Object.keys(cursorHooks.hooks).sort(), ["sessionStart", "stop"]);
    assert.ok(!cursorHooks.hooks.PreToolUse);
    assert.match(cursorHooks.hooks.sessionStart[0].command, /host\.cjs/);
  });

  it("derives plan_present, role, and next_action from visible Markdown", () => {
    const cwd = path.join(tmp, "ready");
    mkdirSync(cwd);
    writePlan(cwd, READY_PLAN);
    const derived = host.deriveContext(cwd);
    assert.equal(derived.plan_present, true);
    assert.equal(derived.router_invoked, true);
    assert.equal(derived.assigned_role, "crewmate");
    assert.equal(derived.next_action_known, true);
    assert.equal(derived.next_action, "write host adapter");
  });

  it("does not invent router_invoked or role from a host tool event", () => {
    const cwd = path.join(tmp, "empty");
    mkdirSync(cwd);
    const derived = host.deriveContext(cwd);
    assert.equal(derived.plan_present, false);
    assert.equal(derived.router_invoked, false);
    assert.equal(derived.assigned_role, undefined);
    assert.equal(derived.next_action_known, false);

    const response = host.handle({
      session_id: "s1",
      transcript_path: "/tmp/transcript.jsonl",
      cwd,
      hook_event_name: "SessionStart",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    const context = response.hookSpecificOutput.additionalContext;
    assert.match(context, /ADVISE/);
    assert.match(context, /context_incomplete/);
    assert.doesNotMatch(context, /context_ready/);
    assert.notEqual(response.decision, "block");
  });

  it("treats template placeholders as missing context", () => {
    const cwd = path.join(tmp, "placeholders");
    mkdirSync(cwd);
    writePlan(cwd, INCOMPLETE_PLAN);
    const derived = host.deriveContext(cwd);
    assert.equal(derived.plan_present, true);
    assert.equal(derived.router_invoked, false);
    assert.equal(derived.assigned_role, undefined);
    assert.equal(derived.next_action_known, false);
  });

  it("unfilled Journey-settings placeholders do not mark the Router invoked", () => {
    const cwd = path.join(tmp, "journey-settings-placeholder");
    mkdirSync(cwd);
    writePlan(
      cwd,
      `# Journey template copy\n\n- journey: <Explorer Journey | Expedition>\n- review_cadence: at-end\n- choice_basis: <owner-confirmed recommendation and reason>\n- lineup_snapshot: <named active, standby, and unused role instances>\n`
    );
    const derived = host.deriveContext(cwd);
    assert.equal(derived.router_invoked, false);
    assert.equal(derived.journey, null);
    assert.equal(derived.plan_present, false);
  });

  it("SessionStart with a ready plan advises context_ready", () => {
    const cwd = path.join(tmp, "session-ready");
    mkdirSync(cwd);
    writePlan(cwd, READY_PLAN);
    const response = host.handle({
      session_id: "s2",
      cwd,
      hook_event_name: "SessionStart",
    });
    assert.equal(response.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(response.hookSpecificOutput.additionalContext, /context_ready/);
    assert.equal(response.decision, undefined);
  });

  it("Stop is advisory closeout and never requests protected completion", () => {
    const cwd = path.join(tmp, "stop");
    mkdirSync(cwd);
    writePlan(cwd, READY_PLAN);
    const response = host.handle({
      session_id: "s3",
      cwd,
      hook_event_name: "Stop",
    });
    assert.equal(response.hookSpecificOutput.hookEventName, "Stop");
    assert.match(response.hookSpecificOutput.additionalContext, /closeout/);
    assert.doesNotMatch(response.hookSpecificOutput.additionalContext, /protected_completion/);
    assert.notEqual(response.decision, "block");
  });

  it("unmapped host events fail open as UNAVAILABLE without blocking", () => {
    const response = host.handle({
      cwd: tmp,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "rm -rf /" },
    });
    assert.match(response.hookSpecificOutput.additionalContext, /UNAVAILABLE/);
    assert.match(response.hookSpecificOutput.additionalContext, /unmapped_host_event/);
    assert.notEqual(response.decision, "block");
  });

  it("malformed host input is UNAVAILABLE, never fabricated BLOCK", () => {
    for (const raw of ["{not-json", 42, ["array"]]) {
      const response = host.handle(raw);
      assert.match(String(response.hookSpecificOutput.additionalContext), /UNAVAILABLE/);
      assert.notEqual(response.decision, "block");
    }
  });

  it("CLI adapter exits 0 and prints host JSON for a Claude SessionStart event", () => {
    const cwd = path.join(tmp, "cli");
    mkdirSync(cwd);
    const result = runHost({
      session_id: "s4",
      transcript_path: "/tmp/t.jsonl",
      cwd,
      hook_event_name: "SessionStart",
      tool_name: "Write",
      tool_input: { file_path: "x.md" },
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(parsed.hookSpecificOutput.additionalContext, /ADVISE|UNAVAILABLE/);
    assert.notEqual(parsed.decision, "block");
  });

  it("CLI adapter exits 0 on empty stdin instead of using host exit 2", () => {
    const result = spawnSync(process.execPath, [HOST_BIN], {
      input: "",
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.match(parsed.hookSpecificOutput.additionalContext, /UNAVAILABLE/);
  });

  it("Stop re-entry with stop_hook_active does not request another continuation", () => {
    const cwd = path.join(tmp, "stop-reentry");
    mkdirSync(cwd);
    writePlan(cwd, READY_PLAN);
    const payload = {
      session_id: "abc123",
      transcript_path: "/tmp/transcript.jsonl",
      cwd,
      permission_mode: "default",
      hook_event_name: "Stop",
      stop_hook_active: true,
      last_assistant_message: "I've completed the refactoring. Here's a summary...",
    };
    const response = host.handle(payload);
    assertQuietSuccess(response);

    const result = runHost(payload);
    assert.equal(result.status, 0, result.stderr);
    assertQuietSuccess(JSON.parse(result.stdout));
  });

  it("SubagentStop re-entry with stop_hook_active does not request another continuation", () => {
    const cwd = path.join(tmp, "subagent-reentry");
    mkdirSync(cwd);
    writePlan(cwd, READY_PLAN);
    const response = host.handle({
      session_id: "abc123",
      cwd,
      hook_event_name: "SubagentStop",
      stop_hook_active: true,
      agent_id: "def456",
      agent_type: "Explore",
    });
    assertQuietSuccess(response);
  });

  it("Stop with no Journey, plan, active task, or assigned role terminates quietly", () => {
    const cwd = path.join(tmp, "empty-stop");
    mkdirSync(cwd);
    const response = host.handle({
      session_id: "s-empty-stop",
      transcript_path: "/tmp/transcript.jsonl",
      cwd,
      hook_event_name: "Stop",
    });
    assertQuietSuccess(response);
    assert.doesNotMatch(JSON.stringify(response), /closeout/);
  });

  it("active incomplete Journey still reports the specific missing handoff fields", () => {
    const cwd = path.join(tmp, "incomplete-journey");
    mkdirSync(cwd);
    writePlan(cwd, INCOMPLETE_PLAN);
    const response = host.handle({
      session_id: "s-incomplete",
      cwd,
      hook_event_name: "Stop",
    });
    const context = response.hookSpecificOutput.additionalContext;
    assert.match(context, /handoff_incomplete:/);
    assert.match(context, /verdict/);
    assert.match(context, /candidate_ref/);
    assert.match(context, /changed_paths/);
    assert.match(context, /tests/);
    assert.match(context, /findings/);
    assert.notEqual(response.decision, "block");
  });

  it("task-block outcome intent cannot complete the compact receipt", () => {
    const cwd = path.join(tmp, "intent-as-receipt");
    mkdirSync(cwd);
    writePlan(cwd, INTENT_AS_RECEIPT_PLAN);
    const derived = host.deriveContext(cwd);
    assert.equal(derived.active_task.outcome, "add host mapping");
    assert.equal(derived.active_task.verdict, undefined);

    const response = host.handle({
      session_id: "s-intent-as-receipt",
      cwd,
      hook_event_name: "Stop",
    });
    const context = response.hookSpecificOutput.additionalContext;
    assert.match(context, /handoff_incomplete:verdict/);
    assert.doesNotMatch(context, /handoff_complete/);
    assert.notEqual(response.decision, "block");
  });

  it("active complete Journey preserves documented advisory closeout", () => {
    const cwd = path.join(tmp, "complete-journey");
    mkdirSync(cwd);
    writePlan(cwd, COMPLETE_PLAN);
    const derived = host.deriveContext(cwd);
    assert.equal(derived.active_task.outcome, "add host mapping");
    assert.equal(derived.active_task.verdict, "PASS");
    const response = host.handle({
      session_id: "s-complete",
      cwd,
      hook_event_name: "Stop",
    });
    const context = response.hookSpecificOutput.additionalContext;
    assert.match(context, /closeout/);
    assert.match(context, /handoff_complete/);
    assert.doesNotMatch(context, /handoff_incomplete/);
    assert.doesNotMatch(context, /protected_completion/);
    assert.notEqual(response.decision, "block");
  });

  it("first-pass Stop discovers a journey-marker-only plan", () => {
    const cwd = path.join(tmp, "journey-marker-only");
    mkdirSync(cwd);
    writePlan(
      cwd,
      `# Lease-first notes

- journey: Explorer Journey
`
    );
    const derived = host.deriveContext(cwd);
    assert.equal(derived.plan_present, true);
    assert.equal(derived.router_invoked, true);
    assert.equal(derived.assigned_role, undefined);
    assert.equal(derived.active_task, null);

    const response = host.handle({
      session_id: "s-journey-marker",
      cwd,
      hook_event_name: "Stop",
    });
    assert.match(response.hookSpecificOutput.additionalContext, /closeout|ADVISE/);
    assert.notEqual(response.decision, "block");
  });

  it("first-pass Stop discovers a checkout_lease-only plan", () => {
    const cwd = path.join(tmp, "lease-only");
    mkdirSync(cwd);
    writePlan(
      cwd,
      `# Visible lease

- checkout_lease:
  - journey: J-A
  - controller: Router
  - repository: alphazede/bearing-lite
  - checkout: wt-main
  - branch: main
  - candidate_revision: 4040dfe
  - acquired_at: 2026-08-18T00:00:00Z
  - generation: 1
  - state: active
`
    );
    const derived = host.deriveContext(cwd);
    assert.equal(derived.plan_present, true);
    assert.equal(derived.router_invoked, true);
    assert.equal(derived.active_task, null);

    const response = host.handle({
      session_id: "s-lease-only",
      cwd,
      hook_event_name: "Stop",
    });
    assert.match(response.hookSpecificOutput.additionalContext, /closeout|ADVISE/);
    assert.notEqual(response.decision, "block");
  });

  it("mapping.md documents quiet Stop cases and first-pass discoverable Journey context", () => {
    const mapping = readFileSync(
      path.join(ROOT, "hooks/com.anthropic.claude-code/mapping.md"),
      "utf8"
    );
    assert.match(mapping, /stop_hook_active/);
    assert.match(mapping, /quiet success/i);
    assert.match(mapping, /no discoverable Journey/);
    assert.match(mapping, /discoverable Journey/);
    assert.match(mapping, /additionalContext/);
    assert.match(mapping, /checkout_lease/);
    assert.match(mapping, /journey marker/);
    assert.match(mapping, /Receipt `verdict`/);
    assert.match(mapping, /task `outcome` is approved intent/);
  });
});
