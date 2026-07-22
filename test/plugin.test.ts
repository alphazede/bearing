import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

describe("Bearing Codex plugin contract", () => {
  it("declares the local Bearing plugin and skill path", async () => {
    const manifest = JSON.parse(await read("../.codex-plugin/plugin.json"));
    expect(manifest).toMatchObject({
      name: "bearing",
      skills: "./skills/",
      author: { name: "William Rumph / AlphaZede" },
      interface: { developerName: "William Rumph / AlphaZede" },
    });
    expect(manifest.version).toMatch(/^0\.1\.0(?:\+codex\.\d{14})?$/);
    const packageJson = JSON.parse(await read("../package.json"));
    expect(packageJson.author).toBe("William Rumph / AlphaZede");
    expect(packageJson.files).toEqual(expect.arrayContaining([
      ".codex-plugin/", "skills/",
    ]));
    expect(packageJson.files).not.toContain("commands/");
    await expect(read("../commands/bearing.toml")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("limits the skill to explicit planning-first launches", async () => {
    const skill = await read("../skills/bearing/SKILL.md");
    expect(skill).toContain("name: bearing");
    expect(skill).toContain("- developer");
    expect(skill).toContain("- public");
    expect(skill).toContain("explicitly invokes `$bearing`");
    expect(skill).toContain("asks to use the Bearing\nskill");
    expect(skill).toContain("keep PATH first");
    expect(skill).toContain("`../../dist/cli.js` relative to this `SKILL.md` directory");
    expect(skill).toContain("Never\nresolve the fallback from the current or target repository");
    expect(skill).toContain("filesystem-wide plugin discovery");
    expect(skill).toContain("with `start --detach`");
    expect(skill).not.toContain("start --no-open");
    expect(skill).toContain("best-effort opens the browser automatically");
    expect(skill).toContain("planning-first journey");
    expect(skill).toContain("ask\nthe owner to approve rerunning the same launch command with host escalation");
    expect(skill).toContain("Limit that escalation to the Bearing CLI listener");
    expect(skill).toContain("do not weaken the sandbox,\ntools, authority, or isolation of any agent Bearing launches");
    expect(skill).toContain("Do not use");
  });

  it("documents explicit browser launch without SessionStart ambiguity", async () => {
    const readme = await read("../README.md");
    expect(readme).toContain("not launch on SessionStart");
    expect(readme).toContain("invoke `$bearing` or ask Codex to use the\nBearing skill");
    expect(readme).toContain("After an explicit invocation");
    expect(readme).toContain("best-effort\nopens the browser automatically");
    expect(readme).toContain("asks for owner\napproval to rerun only the Bearing CLI launch with host escalation");
    expect(readme).toContain("does not weaken the sandbox, tools, authority, or isolation of agents\nBearing starts");
    expect(readme).not.toContain("does\nnot launch automatically");
  });
});
