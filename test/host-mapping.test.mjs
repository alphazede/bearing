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
- review_cadence: per-round

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
});
