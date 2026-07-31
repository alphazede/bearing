import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const prose = (value: string) => value.replace(/\s+/g, " ").trim();
const exec = promisify(execFile);

describe("Bearing plugin contract", () => {
  it("declares matching Codex and Claude Code plugins", async () => {
    const codexManifest = JSON.parse(await read("../.codex-plugin/plugin.json"));
    const claudeManifest = JSON.parse(await read("../.claude-plugin/plugin.json"));
    const marketplace = JSON.parse(await read("../.claude-plugin/marketplace.json"));
    expect(codexManifest).toMatchObject({
      name: "bearing",
      skills: "./plugin-skills/",
      hooks: "./hooks/claude-codex-hooks.json",
      author: { name: "William Rumph / AlphaZede" },
      interface: { developerName: "William Rumph / AlphaZede" },
    });
    expect(codexManifest.version).toBe("0.1.6");
    expect(claudeManifest).toMatchObject({
      name: "bearing",
      version: "0.1.6",
      skills: "./plugin-skills/",
      hooks: "./hooks/claude-codex-hooks.json",
      author: { name: "William Rumph / AlphaZede" },
    });
    expect(marketplace).toMatchObject({
      name: "bearing",
      plugins: [{ name: "bearing", source: "./" }],
    });
    const packageJson = JSON.parse(await read("../package.json"));
    expect(packageJson.version).toBe("0.1.6");
    expect(codexManifest.version).toBe(packageJson.version);
    expect(claudeManifest.version).toBe(packageJson.version);
    expect(packageJson.author).toBe("William Rumph / AlphaZede");
    expect(packageJson.license).toBe("MIT OR Apache-2.0");
    expect(packageJson.files).toEqual(expect.arrayContaining([
      ".claude-plugin/", ".codex-plugin/", "plugin-skills/", "skills/", "hooks/", "SECURITY.md", "LICENSE-MIT", "LICENSE-APACHE",
    ]));
    expect(codexManifest.license).toBe(packageJson.license);
    expect(claudeManifest.license).toBe(packageJson.license);
    expect(packageJson.files).not.toContain("commands/");
    await expect(read("../commands/bearing.toml")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ships a private vulnerability-reporting policy", async () => {
    const security = await read("../SECURITY.md");
    expect(security).toContain("private vulnerability reporting");
    expect(security).toContain("Do not open a public issue");
    const readme = await read("../README.md");
    expect(readme).toContain("[SECURITY.md](SECURITY.md)");
    expect(readme).toContain("/security/advisories/new");
  });

  it("limits the skill to explicit planning-first launches", async () => {
    const skill = await read("../plugin-skills/bearing/SKILL.md");
    const skillProse = prose(skill);
    expect(skill).toContain("name: bearing");
    expect(skillProse).toContain("explicitly invokes `$bearing`, `/bearing`, or directly asks to use Bearing");
    expect(skillProse).toContain("keep PATH first");
    expect(skillProse).toContain("`../../dist/cli.js` relative to this `SKILL.md` directory");
    expect(skillProse).toContain("Never resolve the fallback from the current or target repository");
    expect(skillProse).toContain("never reuse a listener from another or stale Bearing installation");
    expect(skillProse).toContain("filesystem-wide plugin discovery");
    expect(skillProse).toContain("with `start --detach`");
    expect(skillProse).not.toContain("start --no-open");
    expect(skillProse).toContain("best-effort opens the browser automatically");
    expect(skillProse).toContain("planning-first journey");
    expect(skillProse).toContain("ask the owner to approve rerunning the same launch command with host escalation");
    expect(skillProse).toContain("Limit that escalation to the Bearing CLI listener");
    expect(skillProse).toContain("do not weaken the sandbox, tools, authority, or isolation of any agent Bearing launches");
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
      expect(skillProse).toContain("bearing focus begin --request");
      expect(skillProse).toContain("bearing focus validate --run");
      expect(skillProse).toContain(`../../skills/${name}/SKILL.md`);
      expect(skillProse).toContain("Do not claim completion unless it returns `ok: true`");
    }
    const crewmate = prose(await read("../plugin-skills/crewmate/SKILL.md"));
    expect(crewmate).toContain("current owner request explicitly authorizes");
    expect(crewmate).toContain("Never edit Focus state, infer external authority");
  });

  it("keeps Focus hooks silent outside Bearing and advisory inside it", async () => {
    const hook = fileURLToPath(new URL("../hooks/focus-reminder.cjs", import.meta.url));
    const disabled = await exec(process.execPath, [hook, "UserPromptSubmit"], { env: { PATH: process.env.PATH ?? "" } });
    expect(disabled.stdout).toBe("");
    const claude = await exec(process.execPath, [hook, "UserPromptSubmit"], { env: { PATH: process.env.PATH ?? "", BEARING_FOCUS: "1" } });
    expect(claude.stdout).toContain("Bearing Focus mode is active");
    const codex = await exec(process.execPath, [hook, "SubagentStart"], { env: { PATH: process.env.PATH ?? "", BEARING_FOCUS: "1", PLUGIN_DATA: "/tmp/bearing-hook-test" } });
    expect(JSON.parse(codex.stdout)).toMatchObject({ systemMessage: "BEARING:FOCUS", hookSpecificOutput: { hookEventName: "SubagentStart" } });
  });

  it("tracks the built launcher required by fresh Git plugin installs", async () => {
    const repository = new URL("..", import.meta.url);
    const { stdout } = await exec("git", ["ls-files", "--error-unmatch", "dist/cli.js"], { cwd: repository });
    expect(stdout.trim()).toBe("dist/cli.js");
    await expect(read("../dist/cli.js")).resolves.toContain("#!/usr/bin/env node");
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
    expect(readmeProse).toContain("reads the relevant packaged `SKILL.md` files and embeds them");
    expect(readmeProse).toContain("do not need AlphaZede's private skill installation");
    expect(readmeProse).toContain("guarded Explorer, Navigator, and Crewmate wrappers");
    expect(readmeProse).toContain("The internal skills disable user and model invocation");
    expect(readmeProse).toContain("The hook is optional");
    expect(readmeProse).toContain("one-use loopback guard process");
    expect(readmeProse).toContain("security boundaries, artifact validation, approval checks, and deterministic `review.html` generation");
    expect(readmeProse).toContain("not launch on SessionStart");
    expect(readmeProse).toContain("After an explicit invocation");
    expect(readmeProse).toContain("best-effort opens the browser automatically");
    expect(readmeProse).toContain("asks for owner approval to rerun only the Bearing CLI launch with host escalation");
    expect(readmeProse).toContain("does not weaken the sandbox, tools, authority, or isolation of agents Bearing starts");
    expect(readmeProse).not.toContain("does not launch automatically");
  });

  it("keeps the installed headless journey grammar aligned with its stable receipt boundary", async () => {
    const rawReadme = await read("../README.md");
    const rawHeadlessJourney = rawReadme.split("## Headless journey", 2)[1]!.split("## Real browser journey", 1)[0]!;
    const readme = prose(rawHeadlessJourney);
    const rawSkill = await read("../plugin-skills/bearing/SKILL.md");
    expect(rawSkill).toContain("## Browser request");
    expect(rawSkill).toContain("## Explicit CLI or headless request");
    const rawBrowserSkill = rawSkill.split("## Browser request", 2)[1]!.split("## Explicit CLI or headless request", 1)[0]!;
    const rawHeadlessSkill = rawSkill.split("## Explicit CLI or headless request", 2)[1]!;
    const skill = prose(rawHeadlessSkill);
    expect(rawBrowserSkill).toContain("start --detach");
    expect(rawHeadlessSkill).not.toContain("start --detach");
    expect(rawHeadlessSkill).not.toMatch(/start a listener|open(?:ing)? a browser/i);
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
    expect(skill).toMatch(/explicit.*(?:via CLI|headless)/i);
    expect(rawHeadlessJourney).not.toContain("--stage repository-fit");
    expect(rawHeadlessJourney).toContain("--stage set-bearings");
    expect(rawHeadlessJourney.indexOf("journey decide")).toBeLessThan(
      rawHeadlessJourney.indexOf("--stage set-bearings"),
    );
  });
});
