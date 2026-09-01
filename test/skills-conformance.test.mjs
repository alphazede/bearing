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

  it("catalog is exactly 1 router + 4 planning + 6 roles = 11 SKILL.md", () => {
    assert.equal(EXPECTED_CATALOG.length, 11);
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

  it("no Trail Boss or Sub-Explorer skill remains", () => {
    for (const name of ["trail-boss", "sub-explorer"]) {
      assert.ok(!skillDirs.includes(name));
      assert.ok(!existsSync(path.join(SKILLS_DIR, name, "SKILL.md")));
      const negative = validateCatalog([...skillDirs, name]);
      assert.equal(negative.ok, false);
      assert.ok(
        negative.diagnostics.some((d) => d.code === "unexpected_skill" && d.skill === name)
      );
    }
  });

  it("Explorer owns proven-independent lanes; Navigator owns cross-wave conflicts", () => {
    const explorer = readFileSync(path.join(SKILLS_DIR, "explorer", "SKILL.md"), "utf8");
    const navigator = readFileSync(path.join(SKILLS_DIR, "navigator", "SKILL.md"), "utf8");
    const router = readFileSync(path.join(SKILLS_DIR, "bearing-lite", "SKILL.md"), "utf8");
    assert.match(explorer, /proven-independent/);
    assert.match(explorer, /never add a\s+nested coordinator/);
    assert.doesNotMatch(explorer, /Trail Boss|Sub-Explorer|trail-boss|sub-explorer/);
    assert.match(navigator, /cross-wave/);
    assert.match(navigator, /conflict/);
    assert.doesNotMatch(navigator, /Trail Boss|Sub-Explorer|trail-boss|sub-explorer/);
    assert.doesNotMatch(router, /Trail Boss|Sub-Explorer|trail-boss|sub-explorer/);
  });

  it("each skill frontmatter name equals directory and description is present", () => {
    for (const name of skillDirs) {
      const text = readFileSync(path.join(SKILLS_DIR, name, "SKILL.md"), "utf8");
      const verdict = validateSkillDocument(name, text);
      assert.equal(verdict.ok, true, `${name}: ${JSON.stringify(verdict)}`);
      const lines = text.trimEnd().split(/\r?\n/).length;
      const words = text.trim().split(/\s+/).length;
      assert.ok(lines <= 60, `${name}: ${lines} lines must be at most 60`);
      assert.ok(words <= 600, `${name}: ${words} words must be at most 600`);
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
    assert.match(router, /Preparing this Journey\./);
    assert.match(
      router,
      /What Journey shall\s+we Embark on—an Explorer Journey or an Expedition\?/
    );
    assert.match(router, /Is this a\s+good lineup for the roles on this Journey\?/);
    assert.match(router, /after a\s+slice, after an integrated round, or at the end\?/);
    assert.match(router, /Router alone writes Journey\s+planning state/);
    assert.match(router, /plugin\s+hosts are partial/);
    assert.match(router, /skill-copy is skills-only/);
    assert.match(router, /Every ready node gets a fresh session/);
    assert.match(router, /If .*default-role-lineup\.md` is absent, create a\s+proposed copy/);
    assert.match(router, /Never infer identity values/);
    assert.match(router, /planning\s+nodes return owner questions/);
    assert.match(router, /one cheaper and one more expensive alternative/);
    assert.match(router, /what each gives up or buys/);
    assert.match(router, /record the named default explicitly/);
    const route = router.indexOf("What Journey shall");
    const planning = router.indexOf("Repository Fit");
    const lineup = router.indexOf("Is this a");
    const cadence = router.indexOf("Where should the single independent");
    const map = router.indexOf("Invoke Map the Route");
    assert.ok(route >= 0 && route < planning, "route choice must precede planning stages");
    assert.ok(lineup >= 0 && lineup < map, "lineup gate must precede task mapping");
    assert.ok(cadence >= 0 && cadence < map, "cadence gate must precede task mapping");
  });

  it("execution roles revalidate the visible checkout lease at every acting boundary", () => {
    const navigator = readFileSync(path.join(SKILLS_DIR, "navigator", "SKILL.md"), "utf8");
    const explorer = readFileSync(path.join(SKILLS_DIR, "explorer", "SKILL.md"), "utf8");
    const crewmate = readFileSync(path.join(SKILLS_DIR, "crewmate", "SKILL.md"), "utf8");
    const identity =
      /Revalidate the visible checkout\s+lease against the approved Journey,\s+repository, checkout\/worktree, branch,\s+candidate revision, generation,\s+and active state/;
    const failClosed =
      /Released, stale-generation,\s+forged, or\s+branch\/HEAD-drifted leases fail closed/;
    for (const [name, text] of [
      ["navigator", navigator],
      ["explorer", explorer],
      ["crewmate", crewmate],
    ]) {
      assert.match(text, identity, `${name} must revalidate the full lease identity`);
      assert.match(text, /before the first write/, `${name} must revalidate before first write`);
      assert.match(text, failClosed, `${name} must fail closed on drifted or forged leases`);
    }
    assert.match(
      navigator,
      /before the first write,\s+dispatch, integration, or cross-wave transition/
    );
    assert.match(navigator, /same valid lease\s+continues\s+without duplicate dispatch/);
    assert.match(explorer, /before the first write,\s+dispatch, or integration/);
    assert.match(explorer, /same valid lease\s+continues\s+without duplicate dispatch/);
    assert.match(crewmate, /before the first write\s+and\s+every mutation/);
    assert.match(crewmate, /return WAITING_ON without writing/);
  });

  it("recorded Journey lineup snapshot outranks later global-default edits", () => {
    const router = readFileSync(path.join(SKILLS_DIR, "bearing-lite", "SKILL.md"), "utf8");
    const navigator = readFileSync(path.join(SKILLS_DIR, "navigator", "SKILL.md"), "utf8");
    const explorer = readFileSync(path.join(SKILLS_DIR, "explorer", "SKILL.md"), "utf8");
    const crewmate = readFileSync(path.join(SKILLS_DIR, "crewmate", "SKILL.md"), "utf8");
    assert.match(router, /recorded snapshot is authoritative for this Journey/);
    assert.match(
      router,
      /Later edits to\s+`~\/\.agents\/bearing-lite\/default-role-lineup\.md` have no effect on it/
    );
    assert.match(router, /explicit owner-confirmed\s+dated visible amendment/);
    assert.match(router, /lineup identity from the recorded snapshot/);
    for (const [name, text] of [
      ["navigator", navigator],
      ["explorer", explorer],
      ["crewmate", crewmate],
    ]) {
      assert.match(
        text,
        /recorded Journey snapshot/,
        `${name} must read identities from the Journey snapshot`
      );
      assert.match(
        text,
        /never\s+from\s+the\s+current\s+global\s+defaults\s+file/,
        `${name} must not reread the global defaults file`
      );
    }
  });

  it("at-end assurance occurs once at the Journey boundary", () => {
    const explorer = readFileSync(path.join(SKILLS_DIR, "explorer", "SKILL.md"), "utf8");
    const navigator = readFileSync(path.join(SKILLS_DIR, "navigator", "SKILL.md"), "utf8");
    assert.match(explorer, /Expedition wave defers assurance to the Navigator's final\s+Journey boundary/);
    assert.match(navigator, /final integrated\s+boundary/);
  });

  it("Bearing Lite permits one review and one repair without re-review", () => {
    const router = readFileSync(path.join(SKILLS_DIR, "bearing-lite", "SKILL.md"), "utf8");
    const explorer = readFileSync(path.join(SKILLS_DIR, "explorer", "SKILL.md"), "utf8");
    const navigator = readFileSync(path.join(SKILLS_DIR, "navigator", "SKILL.md"), "utf8");
    assert.match(router, /`max_assurance_rounds` is\s+1/);
    assert.match(router, /per Journey/);
    assert.match(router, /assurance_rounds/);
    assert.match(router, /Direct route/);
    assert.match(router, /Navigator is not\s+required|does not depend on Navigator/);
    assert.match(
      router,
      /OWNER_DECISION_REQUIRED` naming the candidate\s+and count/
    );
    assert.match(router, /new Journey resets/);
    for (const [name, text] of [
      ["explorer", explorer],
      ["navigator", navigator],
    ]) {
      assert.match(text, /max_assurance_rounds/, `${name} must honor the Lite bound`);
      assert.match(text, /of 1/, `${name} must fix the Lite bound at one review`);
      assert.match(text, /assurance_rounds/, `${name} must read the visible count`);
      assert.match(
        text,
        /OWNER_DECISION_REQUIRED` with\s+candidate and\s+count/,
        `${name} must escalate with candidate and count`
      );
      assert.match(text, /without another review/, `${name} must not re-review the repair`);
      assert.match(text, /one[\s\S]*repair/, `${name} must allow at most one repair`);
    }
    assert.match(router, /`COMPLETE` ends Bearing assurance/);
    assert.match(router, /deployment[\s\S]*without reopening review/);
  });

  it("Validator and Park Ranger declare terminal versus bounded-correction outcomes", () => {
    const validator = readFileSync(path.join(SKILLS_DIR, "validator", "SKILL.md"), "utf8");
    const park = readFileSync(path.join(SKILLS_DIR, "park-ranger", "SKILL.md"), "utf8");
    assert.match(validator, /`PASS` is terminal/);
    assert.match(validator, /`NEEDS_MORE_EVIDENCE` and `FAIL` permit bounded\s+correction/);
    assert.match(validator, /max_assurance_rounds/);
    assert.match(park, /`ACCEPT`, `ACCEPT_WITH_FINDINGS`, and `BLOCK` are terminal/);
    assert.match(park, /`REPAIR_REQUIRED`\s+permits bounded correction/);
    assert.match(park, /ACCEPT_WITH_FINDINGS` accepts residual/);
    assert.match(park, /do not follow it with another repair/);
    assert.match(park, /max_assurance_rounds/);
    assert.match(park, /of 1/);
    assert.match(park, /Do not\s+review or repair that Journey again/);
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
    assert.match(gather, /Buffer confirmed decisions in the active session/);
    assert.match(gather, /Do not persist, patch, or\s+re-render Journey state after each answer/);
    assert.match(gather, /Return one consolidated decision batch to the Router/);
    assert.match(gather, /handoff\/context\s+loss is imminent/);
    assert.doesNotMatch(gather, /Return each confirmed decision immediately/);
  });

  it("Map the Route presents one integrated owner review", () => {
    const mapRoute = readFileSync(
      path.join(SKILLS_DIR, "map-the-route", "SKILL.md"),
      "utf8"
    );
    const grammar = readFileSync(
      path.join(SKILLS_DIR, "map-the-route", "references", "artifact-grammar.md"),
      "utf8"
    );
    assert.match(mapRoute, /Author in dependency order: testable specification, `design\.md`, `seit\.md`,\s+then `implementation\.md`/);
    assert.match(mapRoute, /one complete self-contained offline `review\.html`/);
    assert.match(mapRoute, /request one\s+integrated owner approval/);
    assert.match(mapRoute, /staged owner approvals only when the owner\s+explicitly requests them/);
    assert.doesNotMatch(mapRoute, /After specification approval/);
    assert.match(grammar, /owner review gate requires all four\s+artifacts plus the complete `review\.html`/);
    assert.match(grammar, /do not insert a specification-only\s+owner gate/);
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

  it("does not package stale role-routing or task-state PNGs", () => {
    const assets = path.join(SKILLS_DIR, "bearing-lite", "assets");
    assert.equal(existsSync(path.join(assets, "role-routing.png")), false);
    assert.equal(existsSync(path.join(assets, "task-state.png")), false);
    const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
    assert.doesNotMatch(readme, /task-state\.png/);
    assert.doesNotMatch(readme, /role-routing\.png/);
    assert.match(readme, /task-state\.mmd/);
    assert.match(readme, /checkout-lease[\s-]+conflict/);
    assert.match(readme, /WAITING_ON/);
    const mermaid = readFileSync(
      path.join(SKILLS_DIR, "bearing-lite", "references", "task-state.mmd"),
      "utf8"
    );
    assert.match(mermaid, /checkout-lease conflict/);
    assert.match(mermaid, /WAITING_ON/);
  });
});
