#!/usr/bin/env node

if (process.env.BEARING_FOCUS !== "1") process.exit(0);

const event = process.argv[2];
if (event !== "UserPromptSubmit" && event !== "SubagentStart") process.exit(0);

const reminder = "Bearing Focus mode is active. Act only on acceptance, evidence, or the current blocker. Preserve the supplied envelope.";
const codex = Boolean(process.env.PLUGIN_DATA);
if (codex || event === "SubagentStart") {
  process.stdout.write(JSON.stringify({
    ...(codex ? { systemMessage: "BEARING:FOCUS" } : {}),
    hookSpecificOutput: { hookEventName: event, additionalContext: reminder },
  }));
} else {
  process.stdout.write(reminder);
}
