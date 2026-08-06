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

  it("launchers use MCP-only calls to bearing_focus_begin, bearing_focus_validate (and review tools for navigator); missing tool yields MCP_SETUP_REQUIRED with no CLI/exec/dist/shell/silent fallback", async () => {
    const navP = await readFile(new URL("../plugin-skills/navigator/SKILL.md", import.meta.url), "utf8");
    const expP = await readFile(new URL("../plugin-skills/explorer/SKILL.md", import.meta.url), "utf8");
    const creP = await readFile(new URL("../plugin-skills/crewmate/SKILL.md", import.meta.url), "utf8");
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    const nN = norm(navP), eN = norm(expP), cN = norm(creP);
    for (const p of ["bearing_focus_begin", "bearing_focus_validate", "MCP_SETUP_REQUIRED", "Never silently fall back"]) {
      expect(nN).toContain(p);
      expect(eN).toContain(p);
      expect(cN).toContain(p);
    }
    for (const p of ["bearing_review_context", "bearing_review_record"]) expect(nN).toContain(p);
    for (const bad of ["dist/cli.js", "bearing focus begin", "Resolve the installed", "../../dist"]) {
      expect(navP).not.toContain(bad);
      expect(expP).not.toContain(bad);
      expect(creP).not.toContain(bad);
    }
  });

  it("no MCP transport terms appear in skills/**", async () => {
    for (const name of ["navigator", "explorer", "crewmate", "surveyor", "validator", "grader", "park-ranger"] as const) {
      const s = await source(name);
      expect(s).not.toMatch(/MCP|bearing_focus_|bearing_review_|transport/i);
    }
  });

  it("navigator consumes immutable owner-supplied wave and maintains strict separation", async () => {
    const skill = await source("navigator");
    const packaged = await readFile(new URL("../plugin-skills/navigator/SKILL.md", import.meta.url), "utf8");
    const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
    const sN = normalize(skill), pN = normalize(packaged);
    for (const ph of [
      "consumes the immutable owner-supplied WaveEnvelope",
      "never creates or widens waveId, objective, startingLedger, targetCredits, allowedRepositoriesAndPaths, authorRoute, reviewSlots, prohibitedActions, stopConditions",
      "owns ordering, packet correction, author failure handling, finding verification, remediation dispatch, integration, evidence, cleanup, and bounded reporting",
      "never authors or reviews product work, accepts its own wave, or starts the next",
      "Credit requires exact revision, clause completion, and committed non-author gates",
      "Remediation makes a new candidate and invalidates older passes",
      "Navigator verifies findings and records gates",
    ]) {
      expect(sN).toContain(ph);
      expect(pN).toContain(ph);
    }
  });

  it("explorer orchestrates only assigned route with no wave, credit or cross-lane duties", async () => {
    const skill = await source("explorer");
    const packaged = await readFile(new URL("../plugin-skills/explorer/SKILL.md", import.meta.url), "utf8");
    const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
    const sN = normalize(skill), pN = normalize(packaged);
    for (const ph of ["orchestrates only its assigned complex route", "no wave selection, credit, or cross-lane integration"]) {
      expect(sN).toContain(ph);
      expect(pN).toContain(ph);
    }
  });

  it("crewmate implements one packet with no delegation review integration ledger or authority interpretation", async () => {
    const skill = await source("crewmate");
    const packaged = await readFile(new URL("../plugin-skills/crewmate/SKILL.md", import.meta.url), "utf8");
    const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
    const sN = normalize(skill), pN = normalize(packaged);
    for (const ph of ["implements exactly one packet", "no delegation, review, integration, ledger update, or authority interpretation"]) {
      expect(sN).toContain(ph);
      expect(pN).toContain(ph);
    }
  });

  it("surveyor is exactly one fresh read-only fallback per review class without native reviewer and reports non-author exact-candidate contract", async () => {
    const skill = await source("surveyor");
    const n = (s: string) => s.replace(/\s+/g, " ").trim();
    const sN = n(skill);
    for (const ph of [
      "one fresh read-only fallback session per general/security review class only without a native reviewer",
      "returns reviewedRevision, exact scope, reviewer/implementer sessions and ancestry, rerun commands, PASS/FAIL/NEEDS_MORE_EVIDENCE, precise findings",
    ]) expect(sN).toContain(ph);
  });

  it("validator checks only evidence sufficiency; grader only rubric; park-ranger only adjudicates/deduplicates; none fills reviewer slots", async () => {
    const v = (await source("validator")).replace(/\s+/g, " ");
    const g = (await source("grader")).replace(/\s+/g, " ");
    const p = (await source("park-ranger")).replace(/\s+/g, " ");
    expect(v).toContain("Validator only checks evidence sufficiency");
    expect(g).toContain("Grader only calculates rubric");
    expect(p).toContain("Park Ranger only adjudicates/deduplicates");
    for (const s of [v, g, p]) expect(s).toContain("fills no reviewer slots");
  });
});
