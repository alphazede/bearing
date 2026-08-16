/**
 * CMD-SKILLS-01 / SEIT-SKILLS-01, SEIT-ACTIVATION-01
 * Skill catalog, frontmatter, size, activation match/non-match.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = path.join(ROOT, "skills");

const ROUTER = "bearing-lite";
const PLANNING = [
  "repository-fit",
  "set-bearings",
  "gather-supplies",
  "map-the-route",
];
const ROLES = [
  "crewmate",
  "explorer",
  "navigator",
  "trail-boss",
  "sub-explorer",
  "validator",
  "park-ranger",
  "surveyor",
];
const EXPECTED_CATALOG = [ROUTER, ...PLANNING, ...ROLES];
/** Core skill body soft limit (bytes). Oversized fixtures must fail. */
const CORE_SKILL_SIZE_LIMIT = 12_000;

/**
 * @typedef {{ code: string, message: string, skill?: string }} SkillDiagnostic
 * @typedef {{ ok: true, name: string, description: string, bodyBytes: number } | { ok: false, diagnostics: SkillDiagnostic[] }} SkillVerdict
 */

/**
 * Parse YAML-like frontmatter from SKILL.md (name/description only).
 * @param {string} text
 */
function parseFrontmatter(text) {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return null;
  }
  const end = text.indexOf("\n---", 4);
  if (end < 0) return null;
  const block = text.slice(4, end);
  /** @type {Record<string, string>} */
  const fields = {};
  let currentKey = null;
  let currentVal = "";
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) {
      if (currentKey) fields[currentKey] = currentVal.trim();
      currentKey = m[1];
      currentVal = m[2] === ">" || m[2] === "|" ? "" : m[2];
      if (m[2] === ">" || m[2] === "|") currentVal = "";
      continue;
    }
    if (currentKey && (/^\s+/.test(line) || line.trim() === "")) {
      currentVal += (currentVal ? " " : "") + line.trim();
    }
  }
  if (currentKey) fields[currentKey] = currentVal.trim();
  return fields;
}

/**
 * @param {string} skillDirName
 * @param {string} skillText
 * @param {{ sizeLimit?: number }} [opts]
 * @returns {SkillVerdict}
 */
export function validateSkillDocument(skillDirName, skillText, opts = {}) {
  /** @type {SkillDiagnostic[]} */
  const diagnostics = [];
  const sizeLimit = opts.sizeLimit ?? CORE_SKILL_SIZE_LIMIT;
  const bodyBytes = Buffer.byteLength(skillText, "utf8");
  if (bodyBytes > sizeLimit) {
    diagnostics.push({
      code: "oversized_core_skill",
      message: `skill ${skillDirName} is ${bodyBytes} bytes; limit ${sizeLimit}`,
      skill: skillDirName,
    });
  }
  const fm = parseFrontmatter(skillText);
  if (!fm) {
    diagnostics.push({
      code: "invalid_frontmatter",
      message: `skill ${skillDirName} missing valid frontmatter`,
      skill: skillDirName,
    });
    return { ok: false, diagnostics };
  }
  if (!fm.name) {
    diagnostics.push({
      code: "invalid_frontmatter",
      message: "frontmatter name is required",
      skill: skillDirName,
    });
  } else if (fm.name !== skillDirName) {
    diagnostics.push({
      code: "name_directory_mismatch",
      message: `frontmatter name "${fm.name}" !== directory "${skillDirName}"`,
      skill: skillDirName,
    });
  }
  if (!fm.description || fm.description.length < 8) {
    diagnostics.push({
      code: "missing_description",
      message: "frontmatter description is required",
      skill: skillDirName,
    });
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  return {
    ok: true,
    name: fm.name,
    description: fm.description,
    bodyBytes,
  };
}

/**
 * Simple activation match: query tokens against skill description + match cues.
 * @param {string} skillName
 * @param {string} description
 * @param {string} query
 */
export function activationMatches(skillName, description, query) {
  const q = query.toLowerCase();
  const hay = `${skillName} ${description}`.toLowerCase();
  // Explicit name / primary phrase hits.
  if (q.includes(skillName.replace(/-/g, " ")) || q.includes(skillName)) return true;
  // Description "Use for X" fragments: require multi-token overlap beyond single stop words.
  const tokens = q
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 3 && !["with", "from", "that", "this", "work", "task"].includes(t));
  const hits = tokens.filter((t) => hay.includes(t));
  return hits.length >= 2;
}

/**
 * @param {string[]} catalogNames
 * @returns {{ ok: boolean, diagnostics: SkillDiagnostic[] }}
 */
export function validateCatalog(catalogNames) {
  /** @type {SkillDiagnostic[]} */
  const diagnostics = [];
  const set = new Set(catalogNames);
  if (set.has("grader")) {
    diagnostics.push({
      code: "standalone_grader_present",
      message: "standalone grader skill is prohibited; Validator retains grading",
      skill: "grader",
    });
  }
  for (const expected of EXPECTED_CATALOG) {
    if (!set.has(expected)) {
      diagnostics.push({
        code: "missing_role",
        message: `catalog missing required skill "${expected}"`,
        skill: expected,
      });
    }
  }
  // Detect duplicate contract names (same basename listed twice).
  const seen = new Map();
  for (const name of catalogNames) {
    seen.set(name, (seen.get(name) || 0) + 1);
  }
  for (const [name, count] of seen) {
    if (count > 1) {
      diagnostics.push({
        code: "duplicate_contract",
        message: `skill "${name}" appears ${count} times`,
        skill: name,
      });
    }
  }
  // Extra non-catalog skills with SKILL.md are catalog violations for Lite surface.
  for (const name of catalogNames) {
    if (!EXPECTED_CATALOG.includes(name) && name !== "grader") {
      diagnostics.push({
        code: "unexpected_skill",
        message: `unexpected skill "${name}" outside Lite catalog`,
        skill: name,
      });
    }
  }
  return { ok: diagnostics.length === 0, diagnostics };
}

function listSkillDirsWithSkillMd() {
  return readdirSync(SKILLS_DIR)
    .filter((name) => {
      const skillPath = path.join(SKILLS_DIR, name, "SKILL.md");
      return existsSync(skillPath) && statSync(path.join(SKILLS_DIR, name)).isDirectory();
    })
    .sort();
}

describe("CMD-SKILLS-01 skills-conformance (SEIT-SKILLS-01, SEIT-ACTIVATION-01)", () => {
  const skillDirs = listSkillDirsWithSkillMd();

  it("catalog is exactly 1 router + 4 planning + 8 roles = 13 SKILL.md", () => {
    assert.equal(EXPECTED_CATALOG.length, 13);
    assert.deepEqual(skillDirs, [...EXPECTED_CATALOG].sort());
    const catalogVerdict = validateCatalog(skillDirs);
    assert.equal(catalogVerdict.ok, true, JSON.stringify(catalogVerdict));
  });

  it("no standalone grader skill remains", () => {
    assert.ok(!skillDirs.includes("grader"));
    assert.ok(!existsSync(path.join(SKILLS_DIR, "grader", "SKILL.md")));
    const negative = validateCatalog([...skillDirs, "grader"]);
    assert.equal(negative.ok, false);
    assert.ok(negative.diagnostics.some((d) => d.code === "standalone_grader_present"));
  });

  it("no Delegate Authority skill remains", () => {
    assert.ok(!skillDirs.includes("delegate-authority"));
    assert.ok(!existsSync(path.join(SKILLS_DIR, "delegate-authority", "SKILL.md")));
    const negative = validateCatalog([...skillDirs, "delegate-authority"]);
    assert.equal(negative.ok, false);
    assert.ok(
      negative.diagnostics.some(
        (d) => d.code === "unexpected_skill" && d.skill === "delegate-authority"
      )
    );
  });

  it("each skill frontmatter name equals directory and description is present", () => {
    for (const name of skillDirs) {
      const text = readFileSync(path.join(SKILLS_DIR, name, "SKILL.md"), "utf8");
      const verdict = validateSkillDocument(name, text);
      assert.equal(verdict.ok, true, `${name}: ${JSON.stringify(verdict)}`);
      const lines = text.trimEnd().split(/\r?\n/).length;
      const words = text.trim().split(/\s+/).length;
      assert.ok(lines < 60, `${name}: ${lines} lines must be below 60`);
      assert.ok(words < 400, `${name}: ${words} words must be below 400`);
    }
  });

  it("matching activation cases succeed for representative roles", () => {
    const cases = [
      ["crewmate", "implement packet with write-set change as crewmate"],
      ["explorer", "orchestrate wave of crewmate packets as explorer"],
      ["navigator", "sequence expedition waves as navigator"],
      ["validator", "validator sufficiency check for candidate"],
      ["repository-fit", "repository fit choose repo workspace"],
    ];
    for (const [name, query] of cases) {
      const text = readFileSync(path.join(SKILLS_DIR, name, "SKILL.md"), "utf8");
      const verdict = validateSkillDocument(name, text);
      assert.equal(verdict.ok, true);
      if (verdict.ok) {
        assert.equal(
          activationMatches(name, verdict.description, query),
          true,
          `${name} should match: ${query}`
        );
      }
    }
  });

  it("non-matching broad / name-similarity wording keeps unneeded roles dormant", () => {
    // Name-similarity: "validate the plan structure" should not activate park-ranger.
    // Broad: "do some repository work" should not force navigator.
    const park = readFileSync(path.join(SKILLS_DIR, "park-ranger", "SKILL.md"), "utf8");
    const parkV = validateSkillDocument("park-ranger", park);
    assert.equal(parkV.ok, true);
    if (parkV.ok) {
      assert.equal(
        activationMatches("park-ranger", parkV.description, "validate the plan structure quickly"),
        false,
        "park-ranger must stay dormant for name-similar non-match"
      );
    }
    const nav = readFileSync(path.join(SKILLS_DIR, "navigator", "SKILL.md"), "utf8");
    const navV = validateSkillDocument("navigator", nav);
    assert.equal(navV.ok, true);
    if (navV.ok) {
      assert.equal(
        activationMatches("navigator", navV.description, "do some repository work"),
        false,
        "navigator must stay dormant for broad wording"
      );
    }
  });

  it("router requires explicit Bearing invocation and owns the Journey conversation", () => {
    const routerPath = path.join(SKILLS_DIR, "bearing-lite", "SKILL.md");
    const router = readFileSync(routerPath, "utf8");
    const verdict = validateSkillDocument("bearing-lite", router);
    assert.equal(verdict.ok, true);
    if (verdict.ok) {
      assert.equal(
        activationMatches(
          "bearing-lite",
          verdict.description,
          "Use Bearing Lite to start this repository journey"
        ),
        true,
        "explicit Bearing Lite request should match"
      );
      assert.equal(
        activationMatches(
          "bearing-lite",
          verdict.description,
          "route the next task for this repository"
        ),
        false,
        "ordinary repository routing must not invoke Bearing Lite"
      );
    }
    assert.match(router, /Gathering Supplies for this Journey\./);
    assert.match(
      router,
      /What Journey shall\s+we Embark on—an Explorer Journey or an Expedition\?/
    );
    assert.match(router, /Is this a\s+good lineup for the roles on this Journey\?/);
    assert.match(router, /per slice, per round, or\s+at the end\?/);
    assert.match(router, /Router alone writes Journey\s+planning state/);
    assert.match(router, /plugin\s+hosts are partial/);
    assert.match(router, /skill-copy is skills-only/);
    assert.match(router, /Every node gets a fresh session/);
    assert.match(router, /If .*default-role-lineup\.md` is absent, create a\s+proposed copy/);
    assert.match(router, /Never infer identity values/);
  });

  it("at-end assurance occurs once at the Journey boundary", () => {
    const explorer = readFileSync(path.join(SKILLS_DIR, "explorer", "SKILL.md"), "utf8");
    const navigator = readFileSync(path.join(SKILLS_DIR, "navigator", "SKILL.md"), "utf8");
    assert.match(explorer, /Expedition wave defers assurance to the Navigator's\s+final Journey boundary/);
    assert.match(navigator, /only the final integrated outcome/);
  });

  it("Gather Supplies converges one recommended question at a time", () => {
    const gather = readFileSync(
      path.join(SKILLS_DIR, "gather-supplies", "SKILL.md"),
      "utf8"
    );
    assert.match(gather, /Ask exactly one question/);
    assert.match(gather, /recommended answer/);
    assert.match(gather, /Never ask the\s+owner for a fact tools can establish/);
    assert.match(gather, /explicit confirmation that shared understanding/);
    assert.match(gather, /Return each confirmed decision immediately to the Router/);
  });

  it("Codex metadata keeps the router explicitly invoked", () => {
    const metadataPath = path.join(SKILLS_DIR, "bearing-lite", "agents", "openai.yaml");
    assert.ok(existsSync(metadataPath), "router must publish Codex activation metadata");
    const metadata = readFileSync(metadataPath, "utf8");
    assert.match(metadata, /allow_implicit_invocation:\s*false/);
    assert.match(metadata, /\$bearing-lite/);
  });

  it("negative: missing role fails with typed diagnostic", () => {
    const incomplete = EXPECTED_CATALOG.filter((n) => n !== "crewmate");
    const verdict = validateCatalog(incomplete);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.diagnostics.some((d) => d.code === "missing_role" && d.skill === "crewmate"));
  });

  it("negative: invalid frontmatter fails with typed diagnostic", () => {
    const verdict = validateSkillDocument("crewmate", "# No frontmatter\n\nBody only.\n");
    assert.equal(verdict.ok, false);
    assert.ok(verdict.diagnostics.some((d) => d.code === "invalid_frontmatter"));
  });

  it("negative: oversized core skill fails with typed diagnostic", () => {
    const big =
      "---\nname: crewmate\ndescription: implement packets\n---\n\n" + "x".repeat(20_000);
    const verdict = validateSkillDocument("crewmate", big, { sizeLimit: CORE_SKILL_SIZE_LIMIT });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.diagnostics.some((d) => d.code === "oversized_core_skill"));
  });

  it("negative: duplicate contract fails with typed diagnostic", () => {
    const verdict = validateCatalog([...EXPECTED_CATALOG, "crewmate"]);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.diagnostics.some((d) => d.code === "duplicate_contract"));
  });
});
