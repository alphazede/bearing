import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const prose = (value: string) => value.replace(/\s+/g, " ").trim();

describe("Bearing plugin contract", () => {
  it("declares matching Codex and Claude Code plugins", async () => {
    const codexManifest = JSON.parse(await read("../.codex-plugin/plugin.json"));
    const claudeManifest = JSON.parse(await read("../.claude-plugin/plugin.json"));
    const marketplace = JSON.parse(await read("../.claude-plugin/marketplace.json"));
    expect(codexManifest).toMatchObject({
      name: "bearing",
      skills: "./skills/",
      author: { name: "William Rumph / AlphaZede" },
      interface: { developerName: "William Rumph / AlphaZede" },
    });
    expect(codexManifest.version).toMatch(/^0\.1\.0(?:\+codex\.\d{14})?$/);
    expect(claudeManifest).toMatchObject({
      name: "bearing",
      version: "0.1.0",
      skills: "./skills/",
      author: { name: "William Rumph / AlphaZede" },
    });
    expect(marketplace).toMatchObject({
      name: "bearing",
      plugins: [{ name: "bearing", source: "./" }],
    });
    const packageJson = JSON.parse(await read("../package.json"));
    expect(packageJson.author).toBe("William Rumph / AlphaZede");
    expect(packageJson.license).toBe("MIT OR Apache-2.0");
    expect(packageJson.files).toEqual(expect.arrayContaining([
      ".claude-plugin/", ".codex-plugin/", "skills/", "SECURITY.md", "LICENSE-MIT", "LICENSE-APACHE",
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
    const skill = await read("../skills/bearing/SKILL.md");
    const skillProse = prose(skill);
    expect(skill).toContain("name: bearing");
    expect(skill).toContain("- developer");
    expect(skill).toContain("- public");
    expect(skillProse).toContain("explicitly invokes `$bearing`, `/bearing`, or directly asks to use Bearing");
    expect(skillProse).toContain("keep PATH first");
    expect(skillProse).toContain("`../../dist/cli.js` relative to this `SKILL.md` directory");
    expect(skillProse).toContain("Never resolve the fallback from the current or target repository");
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

  it("documents both plugin entry points without implying npm availability", async () => {
    const readme = await read("../README.md");
    const readmeProse = prose(readme);
    expect(readmeProse).toContain("packaged for Codex and Claude Code");
    expect(readmeProse).toContain("invoke `$bearing` or ask Codex to use the Bearing skill");
    expect(readme).toContain("/plugin marketplace add alphazede/bearing");
    expect(readme).toContain("/plugin install bearing@bearing");
    expect(readmeProse).toContain("Invoke `/bearing` or ask Claude to use Bearing");
    expect(readmeProse).toContain("has not yet been published");
    expect(readmeProse).toContain("not launch on SessionStart");
    expect(readmeProse).toContain("After an explicit invocation");
    expect(readmeProse).toContain("best-effort opens the browser automatically");
    expect(readmeProse).toContain("asks for owner approval to rerun only the Bearing CLI launch with host escalation");
    expect(readmeProse).toContain("does not weaken the sandbox, tools, authority, or isolation of agents Bearing starts");
    expect(readmeProse).not.toContain("does not launch automatically");
  });
});
