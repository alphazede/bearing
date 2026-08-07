#!/usr/bin/env node

const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const event = process.argv[2];
if (event !== "UserPromptSubmit" && event !== "SubagentStart") process.exit(0);

function submittedPrompt() {
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    return typeof input.prompt === "string" ? input.prompt : "";
  } catch {
    return "";
  }
}

const prompt = event === "UserPromptSubmit" ? submittedPrompt() : "";
const directRole = "navigator|explorer|crewmate|surveyor|set[- ]bearings|gather[- ]supplies|map[- ]the[- ]route";
const bearingRequest = /(?:\$|\/)bearing(?:\:[a-z0-9-]+)?\b/i.test(prompt)
  || new RegExp(`(?:\\$|\\/)(?:${directRole})\\b`, "i").test(prompt)
  || new RegExp(`\\b(?:use|run|start|launch|invoke|dispatch|act as|be)\\s+(?:the\\s+)?(?:bearing(?:\\s+(?:${directRole}))?|${directRole})\\b`, "i").test(prompt)
  || new RegExp(`^ROLE\\s*\\r?\\n\\s*(?:${directRole})\\b`, "im").test(prompt);
const focus = process.env.BEARING_FOCUS === "1";
if (!bearingRequest && !focus) process.exit(0);

const entrypoint = resolve(__dirname, "../plugin-skills/bearing/SKILL.md");
const reminders = [
  `Before using Bearing or any Bearing skill, read ${entrypoint} completely and follow it. If the mode is omitted, ask whether to use guided workflow here, browser UI, or headless CLI, then wait.`,
  "Use Claude Code as the implementation route. If Claude Code usage is exhausted, replace that route with the protected grok-safe wrapper; never use raw Grok, and recompute verifier-family separation.",
  ...(focus ? ["Bearing Focus mode is active. Act only on acceptance, evidence, or the current blocker. Preserve the supplied envelope."] : []),
];
const reminder = reminders.join(" ");
const codex = Boolean(process.env.PLUGIN_DATA);
if (codex || event === "SubagentStart") {
  process.stdout.write(JSON.stringify({
    ...(codex ? { systemMessage: focus ? "BEARING:FOCUS" : "BEARING:ENTRYPOINT" } : {}),
    hookSpecificOutput: { hookEventName: event, additionalContext: reminder },
  }));
} else {
  process.stdout.write(reminder);
}
