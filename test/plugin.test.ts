import { readFile } from "node:fs/promises";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const prose = (value: string) => value.replace(/\s+/g, " ").trim();
const exec = promisify(execFile);

describe("Bearing plugin contract", () => {
  it("declares matching Codex and Claude Code plugins", async () => {
    const codexManifest = JSON.parse(await read("../.codex-plugin/plugin.json"));
    const codexMcp = JSON.parse(await read("../.mcp.json"));
    const claudeManifest = JSON.parse(await read("../.claude-plugin/plugin.json"));
    const marketplace = JSON.parse(await read("../.claude-plugin/marketplace.json"));
    expect(codexManifest).toMatchObject({
      name: "bearing",
      skills: "./plugin-skills/",
      hooks: "./hooks/claude-codex-hooks.json",
      author: { name: "William Rumph / AlphaZede" },
      interface: { developerName: "William Rumph / AlphaZede" },
    });
    expect(codexManifest.version).toBe("0.1.7");
    expect(claudeManifest).toMatchObject({
      name: "bearing",
      version: "0.1.7",
      skills: "./plugin-skills/",
      hooks: "./hooks/claude-codex-hooks.json",
      author: { name: "William Rumph / AlphaZede" },
    });
    expect(marketplace).toMatchObject({
      name: "bearing",
      plugins: [{ name: "bearing", source: "./" }],
    });
    const packageJson = JSON.parse(await read("../package.json"));
    expect(packageJson.version).toBe("0.1.7");
    expect(codexManifest.version).toBe(packageJson.version);
    expect(claudeManifest.version).toBe(packageJson.version);
    expect(packageJson.author).toBe("William Rumph / AlphaZede");
    expect(packageJson.license).toBe("Apache-2.0");
    expect(packageJson.files).toEqual(expect.arrayContaining([
      ".mcp.json", ".claude-plugin/", ".codex-plugin/", "plugin-skills/", "skills/", "hooks/", "SECURITY.md", "LICENSE-APACHE",
    ]));
    // Guides live in guide/, never docs/. docs/ is gitignored because Bearing
    // writes private plans there, so packaging it would publish another
    // repository's planning artifacts.
    expect(packageJson.files).toContain("guide/");
    expect(packageJson.files).not.toContain("docs/");
    expect(codexManifest.license).toBe(packageJson.license);
    expect(claudeManifest.license).toBe(packageJson.license);
    expect(packageJson.files).not.toContain("commands/");
    await expect(read("../commands/bearing.toml")).rejects.toMatchObject({ code: "ENOENT" });
    // Codex resolves the companion descriptor from the installed plugin root.
    expect(codexManifest.mcpServers).toBe("./.mcp.json");
    expect(codexMcp.mcpServers.bearing).toEqual({
      command: "node",
      args: ["./dist/cli.js", "mcp"],
      cwd: ".",
    });
    expect(claudeManifest.mcpServers.bearing.command).toBe("node");
    expect(claudeManifest.mcpServers.bearing.args[0]).toMatch(/^\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/cli\.js$/);
    expect(claudeManifest.mcpServers.bearing.args[1]).toBe("mcp");
    expect(codexMcp.mcpServers.bearing.args[0]).not.toBe(claudeManifest.mcpServers.bearing.args[0]);
  });

  it("ships a private vulnerability-reporting policy", async () => {
    const security = await read("../SECURITY.md");
    expect(security).toContain("private vulnerability reporting");
    expect(security).toContain("Do not open a public issue");
    const readme = await read("../README.md");
    expect(readme).toContain("[SECURITY.md](SECURITY.md)");
    expect(readme).toContain("/security/advisories/new");
  });

  it("matches explicit Bearing requests, rejects ordinary planning, and asks for an omitted mode", async () => {
    const skill = await read("../plugin-skills/bearing/SKILL.md");
    const skillProse = prose(skill);
    const matches = (request: string) => /(?:\$bearing|\/bearing|(?:use|run|start) Bearing)/i.test(request);
    expect(skill).toContain("name: bearing");
    expect(matches("Use Bearing for this repository")).toBe(true);
    expect(matches("Plan a bounded repository repair")).toBe(false);
    expect(skillProse).toContain("If mode is named, do not ask again");
    expect(skillProse).toContain("How would you like to use Bearing: guided workflow here, browser UI, or headless CLI?");
    expect(skillProse).toContain("run `node <bundled dist/cli.js> resolve-cli`");
    expect(skillProse).toContain("`../../dist/cli.js` relative to this `SKILL.md`");
    expect(skillProse).toContain("used only when the receipt's `reason` is `path_preferred`");
    expect(skillProse).toContain("never silently fall back to an older or unverified PATH binary");
    expect(skillProse).toContain("Never search the current or target repository");
    expect(skillProse).toContain("Never reuse another or stale installation's listener");
    expect(skillProse).toContain("filesystem-wide plugin discovery");
    expect(skillProse).toContain("`bearing start --detach`");
    expect(skillProse).not.toContain("start --no-open");
    expect(skillProse).toContain("best-effort opens the browser automatically");
    expect(skillProse).toContain("ask before rerunning only that launch with host escalation");
    expect(skillProse).toContain("do not weaken agent tools, authority, or isolation");
    expect(skillProse).toContain("host agent's native collaboration behavior");
    expect(skillProse).not.toContain("Codex native collaboration");
    expect(skillProse).toContain("Do not use");
  });

  it("ships Map the Route as one frontend-aligned planning owner", async () => {
    const skill = await read("../skills/map-the-route/SKILL.md");
    const skillProse = prose(skill);
    expect(skill).toContain("name: map-the-route");
    expect(skillProse).toContain("design-and-SEIT validation checkpoint");
    expect(skillProse).toContain("Write `implementation.md`");
    expect(skillProse).toContain("Bearing owns deterministic `review.html` generation");
    expect(skillProse).toContain("complete current `plan-spec.md`, `design.md`, `seit.md`, and `implementation.md`");
    expect(skillProse).not.toContain("$to-plan");
    expect(skillProse).not.toContain("$map-the-route");
  });

  it("ships every frontend workflow skill in the npm package", async () => {
    const names = ["set-bearings", "gather-supplies", "map-the-route", "explorer", "navigator", "crewmate", "surveyor"];
    for (const name of names) {
      const skill = await read(`../skills/${name}/SKILL.md`);
      expect(skill).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: [^\\n]+\\nuser-invocable: false\\ndisable-model-invocation: true\\n---\\n`));
    }
  });

  it("exposes guarded direct roles without exposing raw workflow skills", async () => {
    for (const name of ["explorer", "navigator", "crewmate"]) {
      const skill = await read(`../plugin-skills/${name}/SKILL.md`);
      const skillProse = prose(skill);
      expect(skill).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: [^\\n]+\\n---\\n`));
      expect(skillProse).toContain(`Persist a bounded request containing only \`role: "${name}"\``);
      expect(skillProse).toContain("under the repository's existing `.bearing/focus/` area");
      expect(skillProse).toContain("call the `bearing_focus_begin` MCP tool with `repository` and that exact `requestPath`");
      expect(skillProse).toContain("Keep its returned `focusRunId` and envelope");
      expect(skillProse).toContain("persist a receipt containing the `runtimeIdentity` value returned verbatim by `bearing_focus_begin`, every changed artifact");
      expect(skillProse).toContain("call the `bearing_focus_validate` MCP tool with `repository`, the kept `focusRunId`, and that exact `receiptPath`");
      expect(skillProse).toContain("is unavailable, return `MCP_SETUP_REQUIRED` and stop.");
      expect(skillProse).toContain("Never silently fall back to a shell command, an executable, or parsed CLI output.");
      expect(skillProse).not.toContain("bearing focus begin --request");
      expect(skillProse).not.toContain("bearing focus validate --run");
      expect(skillProse).not.toContain("dist/cli.js");
      expect(skillProse).toContain(`../../skills/${name}/SKILL.md`);
      expect(skillProse).toContain("Do not claim completion unless it returns `ok: true`");
    }
    const crewmate = prose(await read("../plugin-skills/crewmate/SKILL.md"));
    expect(crewmate).toContain("current owner request explicitly authorizes");
    expect(crewmate).toContain("Never edit Focus state, infer external authority");
    // The repair-lane identity exception (issue 61) must be stated wherever the
    // verbatim-begin-identity receipt rule is taught, or the skill contradicts
    // the guard's declared-repair-slice handling.
    expect(crewmate).toContain("For a declared Focus-runtime repair slice, bind the receipt to the produced runtime identity of the repaired source instead of the begin value");
  });

  it("keeps Focus hooks silent outside Bearing and advisory inside it", () => {
    const hook = fileURLToPath(new URL("../hooks/focus-reminder.cjs", import.meta.url));
    const run = (event: string, env: NodeJS.ProcessEnv) => spawnSync(process.execPath, [hook, event], {
      encoding: "utf8", env, input: JSON.stringify({ prompt: "" }),
    });
    const disabled = run("UserPromptSubmit", { PATH: process.env.PATH ?? "" });
    expect(disabled.stdout).toBe("");
    const claude = run("UserPromptSubmit", { PATH: process.env.PATH ?? "", BEARING_FOCUS: "1" });
    expect(claude.stdout).toContain("Bearing Focus mode is active");
    const codex = run("SubagentStart", { PATH: process.env.PATH ?? "", BEARING_FOCUS: "1", PLUGIN_DATA: "/tmp/bearing-hook-test" });
    expect(JSON.parse(codex.stdout)).toMatchObject({ systemMessage: "BEARING:FOCUS", hookSpecificOutput: { hookEventName: "SubagentStart" } });
  });

  it("loads the main Bearing entrypoint for role requests on Codex and Claude only", () => {
    const hook = fileURLToPath(new URL("../hooks/focus-reminder.cjs", import.meta.url));
    const run = (prompt: string, codex: boolean) => spawnSync(process.execPath, [hook, "UserPromptSubmit"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", ...(codex ? { PLUGIN_DATA: "/tmp/bearing-hook-test" } : {}) },
      input: JSON.stringify({ prompt }),
    });
    for (const codex of [true, false]) {
      const matching = run("Use Bearing Navigator for this repository", codex);
      expect(matching.status).toBe(0);
      expect(matching.stdout).toContain("plugin-skills/bearing/SKILL.md");
      expect(matching.stdout).toContain("guided workflow here, browser UI, or headless CLI");
      expect(matching.stdout).toContain("grok-safe");
      const unrelated = run("Fix the navigation spacing in this page", codex);
      expect(unrelated.status).toBe(0);
      expect(unrelated.stdout).toBe("");
    }
  });

  it("tracks the built launcher required by fresh Git plugin installs", async () => {
    const repository = new URL("..", import.meta.url);
    const { stdout } = await exec("git", ["ls-files", "--error-unmatch", "dist/cli.js"], { cwd: repository });
    expect(stdout.trim()).toBe("dist/cli.js");
    await expect(read("../dist/cli.js")).resolves.toContain("#!/usr/bin/env node");
  });

  it("keeps every packaged guide reachable from the README", async () => {
    const repository = new URL("..", import.meta.url);
    const readme = await read("../README.md");
    const { stdout } = await exec("git", ["ls-files", "guide/*.md"], { cwd: repository });
    const guides = stdout.split("\n").filter(Boolean);
    expect(guides.length).toBeGreaterThan(0);
    // Every guide is linked, so splitting the README cannot orphan a page.
    for (const guide of guides) expect(readme).toContain(`(${guide})`);
    // And every relative link resolves, so a moved page fails here, not for a reader.
    const links = [...readme.matchAll(/]\((?!https?:|#)([^)]+)\)/g)].map((m) => m[1]!.split("#")[0]!);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) await expect(read(`../${link}`)).resolves.toBeTruthy();
  });

  it("documents both plugin entry points and packaged skill customization", async () => {
    const readme = await read("../README.md");
    const readmeProse = prose(readme);
    expect(readmeProse).toContain("packaged for Codex and Claude Code");
    expect(readmeProse).toContain("invoke `$bearing` or ask Codex to use the Bearing skill");
    expect(readme).toContain("/plugin marketplace add alphazede/bearing");
    expect(readme).toContain("/plugin install bearing@bearing");
    expect(readmeProse).toContain("Invoke `/bearing` or ask Claude to use Bearing");
    expect(readmeProse).toContain("public npm package is `@alphazede/bearing`");
    expect(readmeProse).toContain("not launch on SessionStart");
    // Skill and Focus detail lives in its own packaged guide, not the README.
    const focus = prose(await read("../guide/focus-mode.md"));
    expect(focus).toContain("reads the relevant packaged `SKILL.md` files and embeds them");
    expect(focus).toContain("do not need AlphaZede's private skill installation");
    expect(focus).toContain("guarded Explorer, Navigator, and Crewmate wrappers");
    expect(focus).toContain("The internal skills disable user and model invocation");
    expect(focus).toContain("The hook is optional");
    expect(focus).toContain("one-use loopback guard process");
    expect(focus).toContain("security boundaries, artifact validation, approval checks, and deterministic `review.html` generation");
    expect(readmeProse).toContain("When the request does not name a mode");
    expect(readmeProse).toContain("guided workflow in the current conversation, open the browser UI, or use the headless CLI");
    expect(readmeProse).toContain("best-effort opens the browser automatically");
    expect(readmeProse).toContain("asks for owner approval to rerun only the Bearing CLI launch with host escalation");
    expect(readmeProse).toContain("does not weaken the sandbox, tools, authority, or isolation of agents Bearing starts");
    expect(readmeProse).not.toContain("does not launch automatically");
  });

  it("keeps the installed headless journey grammar aligned with its stable receipt boundary", async () => {
    // The headless journey is its own packaged guide; the whole page is the section.
    const rawHeadlessJourney = await read("../guide/cli.md");
    const readme = prose(rawHeadlessJourney);
    const rawSkill = await read("../plugin-skills/bearing/SKILL.md");
    expect(rawSkill).toContain("## Guided workflow");
    expect(rawSkill).toContain("## Browser UI");
    expect(rawSkill).toContain("## Headless CLI");
    const rawBrowserSkill = rawSkill.split("## Browser UI", 2)[1]!.split("## Headless CLI", 1)[0]!;
    const rawHeadlessSkill = rawSkill.split("## Headless CLI", 2)[1]!;
    const skill = prose(rawHeadlessSkill);
    expect(rawBrowserSkill).toContain("start --detach");
    expect(rawHeadlessSkill).not.toContain("start --detach");
    expect(rawHeadlessSkill).not.toMatch(/start a listener|open(?:ing)? a browser/i);
    expect(skill).toMatch(/For each later action, run `bearing journey <action>` with the same `--repo`, `--provider`, `--model`, `--reasoning`, and `--run` flags/);
    for (const surface of [readme, skill]) {
      expect(surface).toContain("journey create --repo");
      expect(surface).toContain("journey status");
      expect(surface).toContain("journey resume");
      expect(surface).toContain("journey decide");
      expect(surface).toContain("journey progress --stage");
      expect(surface).toContain("journey approve-route");
      expect(surface).toContain("journey confirm-amendment");
      expect(surface).toContain("journey select-execution");
      expect(surface).toContain("journey select-explorer");
      expect(surface).toContain("allowedActions");
      expect(surface).toContain("requiredOwnerAction");
      expect(surface).toContain("outcome");
      expect(surface).toContain("runId");
      expect(surface).toContain("revision");
      expect(surface).toContain("ok: false");
      expect(surface).toMatch(/same (?:user )?conversation|current conversation/i);
      expect(surface).toMatch(/Explorer.*Expedition|Expedition.*Explorer/i);
      expect(surface).toMatch(/failed.*stopped|stopped.*failed/i);
      expect(surface).toMatch(/attempt only an advertised recovery action/i);
      expect(surface).toMatch(/review/i);
      expect(surface).toMatch(/status: complete/i);
      expect(surface).toMatch(/final (?:summary|artifacts|evidence)/i);
      expect(surface).toMatch(/takes no action-specific flags/i);
      expect(surface).toContain("`requiredOwnerAction.type: confirm-amendment`");
      expect(surface).toContain("`requiredOwnerAction.prompt`");
      expect(surface).toMatch(/failed or stopped same-stage Focus amendment/i);
      expect(surface).toMatch(/never infer or auto-issue/i);
      expect(surface).toContain("`readiness: unavailable`");
      expect(surface).toMatch(/only `status` and `resume`/i);
      expect(surface).toMatch(/no mutating `requiredOwnerAction`/i);
      expect(surface).not.toMatch(/okf_status|BRAN|bearer\s+[A-Za-z0-9._-]+/i);
    }
    expect(rawSkill).toMatch(/guided workflow.*headless CLI/i);
    // Guided mode is MCP-only: it must never be described as falling back to the CLI.
    const rawGuidedSkill = rawSkill.split("## Guided workflow", 2)[1]!.split("## Browser UI", 1)[0]!;
    const guided = prose(rawGuidedSkill);
    expect(guided).toContain("bearing_attach");
    expect(guided).toContain("bearing_transition");
    expect(guided).toContain("bearing_handoff");
    expect(guided).toContain("Never silently fall back to the CLI");
    expect(guided).toContain("typed setup blocker naming the missing `bearing` MCP server");
    expect(guided).toContain("`revision` back as `expectedRevision`");
    expect(rawGuidedSkill).not.toContain("bearing journey ");
    expect(rawGuidedSkill).not.toContain("start --detach");
    expect(rawHeadlessJourney).not.toContain("--stage repository-fit");
    expect(rawHeadlessJourney).toContain("--stage set-bearings");
    expect(rawHeadlessJourney.indexOf("journey decide")).toBeLessThan(
      rawHeadlessJourney.indexOf("--stage set-bearings"),
    );
  });
});
