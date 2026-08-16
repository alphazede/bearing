/**
 * CMD-PUBLIC-01 / SEIT-PUBLIC-01, SEIT-MODEL-01, SEIT-INDEPENDENCE-01
 * Scan packaged Lite public surfaces for private spill, model pins, deep coupling.
 * Includes the S9 public documents.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PACKAGE = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

/**
 * Packed Lite public documents that must be scanned.
 */
const PACKED_PUBLIC_DOCS = [
  "README.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
];
const SCAN_ROOTS = [
  "plugin.json",
  "package.json",
  ".agents/plugins/marketplace.json",
  ".claude-plugin/marketplace.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".grok-plugin/marketplace.json",
  ".grok-plugin/plugin.json",
  ".cursor-plugin/marketplace.json",
  ".cursor-plugin/plugin.json",
  ".kimi-plugin/plugin.json",
  ".agy/plugin.json",
  ".agy/README.md",
  "hooks",
  "skills",
  ...PACKED_PUBLIC_DOCS,
];

const OLD_PACKAGE_NAME_COUPLING = {
  code: "deep_product_coupling",
  re: /@alphazede\/bearing(?!-lite)/,
};

const SECRET_PATTERNS = [
  { code: "secret_pattern", re: /AKIA[0-9A-Z]{16}/ },
  { code: "secret_pattern", re: /-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----/ },
  { code: "secret_pattern", re: /xox[baprs]-[0-9A-Za-z-]{10,}/ },
  { code: "secret_pattern", re: /ghp_[A-Za-z0-9]{20,}/ },
  { code: "secret_pattern", re: /sk-[A-Za-z0-9]{20,}/ },
];

const PRIVATE_PATH_PATTERNS = [
  { code: "private_path", re: /(^|[\s"`'])\/home\/[A-Za-z0-9._-]+\// },
  { code: "private_path", re: /\/Users\/[A-Za-z0-9._-]+\// },
  { code: "private_path", re: /\.bearing\/[A-Za-z0-9._/-]+/ },
  { code: "private_path", re: /\/tmp\/bearing-[A-Za-z0-9._/-]+/ },
];

const MODEL_PIN_PATTERNS = [
  { code: "model_pin", re: /model\s*[:=]\s*["']?(gpt-4|gpt-4o|claude-3|claude-opus|o1-preview|gemini-1\.5)/i },
  { code: "model_pin", re: /"model"\s*:\s*"(gpt-|claude-|o1-|gemini-)/i },
  { code: "provider_route", re: /OPENAI_API_KEY|ANTHROPIC_API_KEY|defaultProvider\s*[:=]/ },
  { code: "credential_lookup", re: /process\.env\.(OPENAI|ANTHROPIC|AZURE_OPENAI)_/ },
];

const DEEP_COUPLING_PATTERNS = [
  OLD_PACKAGE_NAME_COUPLING,
  { code: "deep_product_coupling", re: /require\(["']\.\.\/src\// },
  { code: "deep_product_coupling", re: /from ["']\.\.\/src\// },
  { code: "deep_product_coupling", re: /bearing_focus_begin|mcpServers|createServer\(/ },
  { code: "deep_product_coupling", re: /okf_status|public_boundary\s*:/ },
];

/**
 * @typedef {{ code: string, message: string, path?: string }} PublicDiagnostic
 * @typedef {{ ok: true, scanned: string[] } | { ok: false, diagnostics: PublicDiagnostic[], scanned: string[] }} PublicVerdict
 */

/**
 * @param {string} relPath
 * @param {string} content
 * @returns {PublicDiagnostic[]}
 */
export function scanContent(relPath, content) {
  /** @type {PublicDiagnostic[]} */
  const diagnostics = [];
  const groups = [
    ...SECRET_PATTERNS,
    ...PRIVATE_PATH_PATTERNS,
    ...MODEL_PIN_PATTERNS,
    ...DEEP_COUPLING_PATTERNS,
  ];
  for (const { code, re } of groups) {
    if (!re.test(content)) continue;
    diagnostics.push({
      code,
      message: `${relPath} matches prohibited pattern ${re}`,
      path: relPath,
    });
  }
  return diagnostics;
}

/**
 * Recursively list files under a relative root (no node_modules).
 * @param {string} rel
 * @returns {string[]}
 */
function listFiles(rel) {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) return [];
  const st = statSync(abs);
  if (st.isFile()) return [rel];
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(abs)) {
    if (name === "node_modules" || name === ".git") continue;
    const child = path.join(rel, name);
    const childAbs = path.join(ROOT, child);
    const cst = statSync(childAbs);
    if (cst.isDirectory()) out.push(...listFiles(child));
    else if (cst.isFile()) out.push(child);
  }
  return out;
}

/**
 * Scan packed Lite public surfaces (plugin, skills, hooks, S9 public docs).
 * @param {{ extraFiles?: { path: string, content: string }[] }} [opts]
 * @returns {PublicVerdict}
 */
export function scanPublicLiteSurfaces(opts = {}) {
  /** @type {PublicDiagnostic[]} */
  const diagnostics = [];
  /** @type {string[]} */
  const scanned = [];

  // Identity claims.
  if (PACKAGE.name !== "@alphazede/bearing-lite") {
    diagnostics.push({
      code: "stale_non_lite_identity",
      message: `package name ${PACKAGE.name} is not @alphazede/bearing-lite`,
      path: "package.json",
    });
  }

  for (const root of SCAN_ROOTS) {
    for (const rel of listFiles(root)) {
      // Skip empty deep skill dir remnants; only scan files.
      if (rel.startsWith("skills/bearing/") && !rel.includes("bearing-lite")) {
        // Empty legacy dir — no files expected; if files appear they are deep coupling.
      }
      // Skip deep historical skill package if any non-Lite path appears with SKILL that is not catalog.
      scanned.push(rel);
      let content;
      try {
        content = readFileSync(path.join(ROOT, rel), "utf8");
      } catch {
        // binary skip
        continue;
      }
      // Skip binary-ish
      if (content.includes("\u0000")) continue;
      diagnostics.push(...scanContent(rel, content));
    }
  }

  for (const extra of opts.extraFiles || []) {
    scanned.push(extra.path);
    diagnostics.push(...scanContent(extra.path, extra.content));
  }

  if (diagnostics.length) return { ok: false, diagnostics, scanned };
  return { ok: true, scanned };
}

describe("CMD-PUBLIC-01 public-boundary (SEIT-PUBLIC-01, SEIT-MODEL-01, SEIT-INDEPENDENCE-01)", () => {
  it("package identity is @alphazede/bearing-lite with public files allowlist only", () => {
    assert.equal(PACKAGE.name, "@alphazede/bearing-lite");
    assert.ok(Array.isArray(PACKAGE.files));
    assert.ok(PACKAGE.files.includes("plugin.json"));
    assert.ok(PACKAGE.files.includes("skills/"));
    assert.ok(PACKAGE.files.includes("hooks/"));
    assert.ok(!PACKAGE.files.includes("guide/"), "must not pack entire guide/ directory");
    assert.ok(!PACKAGE.files.includes("guide/migration.md"));
    assert.ok(!PACKAGE.files.includes("src/"));
    assert.ok(!PACKAGE.files.includes("dist/"));
    assert.ok(!PACKAGE.files.includes("mcp.json"));
  });

  it("packaged public surfaces scan clean of secrets, private paths, model pins, deep coupling", () => {
    const verdict = scanPublicLiteSurfaces();
    assert.equal(
      verdict.ok,
      true,
      verdict.ok === false ? JSON.stringify(verdict.diagnostics.slice(0, 10), null, 2) : ""
    );
    assert.ok(verdict.scanned.includes("plugin.json"));
    assert.ok(verdict.scanned.some((p) => p.startsWith("hooks/")));
    assert.ok(verdict.scanned.some((p) => p.startsWith("skills/bearing-lite/")));
    for (const doc of PACKED_PUBLIC_DOCS) {
      assert.ok(verdict.scanned.includes(doc), `expected scanned path ${doc}`);
    }
  });

  it("plugin.json and hooks do not pin models or credentials", () => {
    const plugin = readFileSync(path.join(ROOT, "plugin.json"), "utf8");
    assert.equal(scanContent("plugin.json", plugin).length, 0);
    for (const f of readdirSync(path.join(ROOT, "hooks"))) {
      if (!f.endsWith(".cjs")) continue;
      const rel = path.join("hooks", f);
      const hits = scanContent(rel, readFileSync(path.join(ROOT, rel), "utf8"));
      assert.equal(hits.length, 0, JSON.stringify(hits));
    }
  });

  it("S9 packed public documents are in scan roots and clean", () => {
    for (const doc of PACKED_PUBLIC_DOCS) {
      assert.ok(SCAN_ROOTS.includes(doc), `SCAN_ROOTS must include ${doc}`);
      assert.ok(existsSync(path.join(ROOT, doc)), doc);
      const hits = scanContent(doc, readFileSync(path.join(ROOT, doc), "utf8"));
      assert.equal(hits.length, 0, JSON.stringify(hits));
    }
  });

  it("old deep package references fail on every packed path", () => {
    const hits = scanContent(
      "README.md",
      "Deprecate `@alphazede/bearing` with a migration message.\n"
    );
    assert.ok(hits.some((d) => d.code === "deep_product_coupling"));
  });

  it("negative: injected private path fails validation", () => {
    const verdict = scanPublicLiteSurfaces({
      extraFiles: [
        {
          path: "skills/crewmate/FIXTURE.md",
          content: "see evidence at /home/example/private/session.json\n",
        },
      ],
    });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.ok(verdict.diagnostics.some((d) => d.code === "private_path"));
    }
  });

  it("negative: injected secret pattern fails validation", () => {
    const verdict = scanPublicLiteSurfaces({
      extraFiles: [
        {
          path: "hooks/fixture.cjs",
          content: 'const k = "AKIAIOSFODNN7EXAMPLE";\n',
        },
      ],
    });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.ok(verdict.diagnostics.some((d) => d.code === "secret_pattern"));
    }
  });

  it("negative: injected model pin fails validation", () => {
    const verdict = scanPublicLiteSurfaces({
      extraFiles: [
        {
          path: "skills/navigator/FIXTURE.md",
          content: 'default model: "gpt-4o-mini" for all routes\n',
        },
      ],
    });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.ok(verdict.diagnostics.some((d) => d.code === "model_pin"));
    }
  });

  it("negative: injected deep harness coupling fails validation", () => {
    const verdict = scanPublicLiteSurfaces({
      extraFiles: [
        {
          path: "skills/bearing-lite/FIXTURE.md",
          content: "import x from '../src/mcp/server.js'; bearing_focus_begin()\n",
        },
      ],
    });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.ok(verdict.diagnostics.some((d) => d.code === "deep_product_coupling"));
    }
  });
});
