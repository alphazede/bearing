#!/usr/bin/env node
// Dist freshness guard: the committed dist/ must always match a build of the
// current src/. Git-based plugin installs run the tracked dist/cli.js with no
// build step, so stale build output ships as product behavior.
//
// Run it as `pnpm dist-guard`, which builds first and then calls this script.
// It reports every dist path git considers dirty -- modified, deleted, AND
// untracked. Untracked matters most: a newly emitted module is invisible to
// `git diff` yet absent from the package installers actually run.
import { execFileSync } from "node:child_process";

const REPO = process.cwd();
const STATUS_LABEL = { "??": "untracked (never added)", " D": "deleted", "!!": "ignored" };

function git(args) {
  return execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" });
}

let entries;
try {
  // -uall lists untracked files individually instead of collapsing directories.
  // -z keeps paths intact when they contain spaces or quotes.
  entries = git(["status", "--porcelain", "-uall", "-z", "--", "dist"]).split("\0").filter(Boolean);
} catch {
  console.error("dist-guard: cannot read git status for dist/. Failing closed.");
  process.exit(1);
}

const tracked = git(["ls-files", "-z", "dist"]).split("\0").filter(Boolean);
if (tracked.length === 0) {
  console.error("dist-guard FAIL — no dist/ files are tracked, but installers run the committed build output.");
  console.error("Remedy: pnpm build && git add -A dist");
  process.exit(1);
}

if (entries.length > 0) {
  console.error("dist-guard FAIL — committed dist/ does not match a build of the current src/:");
  for (const entry of entries) {
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    console.error(`  - ${path} — ${STATUS_LABEL[code] ?? "modified"}`);
  }
  console.error("Remedy: pnpm build && git add -A dist   (then commit the refreshed build output)");
  process.exit(1);
}

console.log(`dist-guard PASS — all ${tracked.length} tracked dist/ files match a build of the current src/.`);
