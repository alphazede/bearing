import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SKILLS = [
  "repository-fit",
  "set-bearings",
  "gather-supplies",
  "map-the-route",
  "explorer",
  "navigator",
  "crewmate",
  "validator",
  "grader",
  "park-ranger",
  "surveyor",
] as const;

const SECTIONS = [
  "Mission and non-goals",
  "Authority and prohibited actions",
  "Inputs and outputs schema",
  "State read and written",
  "Closed-loop workflow",
  "Entry and exit criteria",
  "Evidence requirements",
  "Failure taxonomy",
  "Escalation and amendment rules",
  "Metrics and trace events",
] as const;

const SECURITY_GUARANTEE_CLAIMS = [
  /\bguarantees?\b/i,
  /\benforces? security\b/i,
  /\bprevents? unauthorized\b/i,
  /\bensures? safety\b/i,
] as const;

const MAX_PACKAGED_SKILL_BYTES = 64 * 1024;
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const source = (name: string) =>
  readFile(new URL(`../skills/${name}/SKILL.md`, import.meta.url), "utf8");

describe("CMD-SKILLS-STRUCTURE", () => {
  for (const name of SKILLS) {
    it(`${name} has the internal packaged-skill contract`, async () => {
      const skill = await source(name);
      const frontmatter = new RegExp(
        `^---\\r?\\nname: ${escapeRegex(name)}\\r?\\ndescription: ([^\\r\\n]+)\\r?\\n` +
          "user-invocable: false\\r?\\ndisable-model-invocation: true\\r?\\n---(?:\\r?\\n|$)",
      );
      const match = frontmatter.exec(skill);

      expect(match).not.toBeNull();
      expect(match?.[1].trim()).not.toBe("");
      expect(Buffer.byteLength(skill)).toBeLessThan(MAX_PACKAGED_SKILL_BYTES);
      expect(skill).not.toContain("\0");

      for (const section of SECTIONS) {
        expect(skill).toMatch(new RegExp(`^## ${escapeRegex(section)}$`, "m"));
      }

      const body = match ? skill.slice(match[0].length) : skill;
      for (const claim of SECURITY_GUARANTEE_CLAIMS) {
        expect(body).not.toMatch(claim);
      }
    });
  }

  it("set-bearings uses only the confirmed resolved plan directory", async () => {
    const skill = await source("set-bearings");
    expect(skill).toContain("Use the confirmed resolved plan directory verbatim.");
    expect(skill).toContain("Never derive, slug, or suffix a plan directory.");
    expect(skill).not.toContain("Match the supplied plan directory to the current goal.");
  });

  it("navigator requires one persistent host goal for autonomous or Expedition mode with concrete resume actions and host-lifecycle completion", async () => {
    const skill = await source("navigator");
    const packaged = await readFile(new URL("../plugin-skills/navigator/SKILL.md", import.meta.url), "utf8");
    const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
    const skillNorm = normalize(skill);
    const packagedNorm = normalize(packaged);
    const requiredPhrases = [
      "In autonomous Navigator or Expedition mode",
      "create or resume one persistent host goal before execution",
      "retain it through recoverable blockers",
      "continue dependency-independent authorized work",
      "store a concrete resume action for each blocked lane",
      "complete only after all authorized slices, gates, reviews, and owner-authorized external actions",
      "mark blocked only under hosting runtime goal threshold and status rules",
      "never bypass owner authority",
    ] as const;
    for (const phrase of requiredPhrases) {
      expect(skillNorm).toContain(phrase);
      expect(packagedNorm).toContain(phrase);
    }
  });
});
