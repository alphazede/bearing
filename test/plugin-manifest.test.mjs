/**
 * CMD-MANIFEST-01 / SEIT-MANIFEST-01, SEIT-EXTENSION-01
 * Exact Agent Plugins v1.0.0 closed-field manifest + extension containment.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_V1 =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

/** Closed top-level field set used by the product for Agent Plugins v1.0.0. */
const CLOSED_TOP_LEVEL = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "skills",
  "hooks",
  "mcpServers",
  "commands",
  "agents",
  "outputStyles",
  "lspServers",
  "userConfig",
]);

/**
 * @typedef {{ code: string, message: string, field?: string }} ManifestDiagnostic
 * @typedef {{ ok: true, name: string, schema: string } | { ok: false, diagnostics: ManifestDiagnostic[] }} ManifestVerdict
 */

/**
 * Validate a plugin manifest object (product or fixture). Pure; no disk writes.
 * @param {unknown} manifest
 * @returns {ManifestVerdict}
 */
export function validatePluginManifest(manifest) {
  /** @type {ManifestDiagnostic[]} */
  const diagnostics = [];
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return {
      ok: false,
      diagnostics: [{ code: "manifest_not_object", message: "manifest must be a plain object" }],
    };
  }
  const m = /** @type {Record<string, unknown>} */ (manifest);

  if (m.$schema !== SCHEMA_V1) {
    diagnostics.push({
      code: "schema_not_v1_0_0",
      message: `expected exact $schema ${SCHEMA_V1}, got ${String(m.$schema)}`,
      field: "$schema",
    });
  }

  if (m.name !== "bearing-lite") {
    diagnostics.push({
      code: "name_mismatch",
      message: `expected name "bearing-lite", got ${JSON.stringify(m.name)}`,
      field: "name",
    });
  }

  for (const key of Object.keys(m)) {
    if (!CLOSED_TOP_LEVEL.has(key)) {
      diagnostics.push({
        code: "unknown_top_level_field",
        message: `unknown top-level field "${key}" is outside the v1.0.0 closed set`,
        field: key,
      });
    }
  }

  // Extension / path containment for optional nested maps that may appear in fixtures.
  for (const section of ["hooks", "mcpServers", "commands", "agents", "lspServers"]) {
    const value = m[section];
    if (value === undefined) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      diagnostics.push({
        code: "section_not_object",
        message: `${section} must be an object map when present`,
        field: section,
      });
      continue;
    }
    for (const [entryKey, entryVal] of Object.entries(
      /** @type {Record<string, unknown>} */ (value)
    )) {
      const pathLike =
        typeof entryVal === "string"
          ? entryVal
          : entryVal &&
              typeof entryVal === "object" &&
              !Array.isArray(entryVal) &&
              typeof /** @type {Record<string, unknown>} */ (entryVal).path === "string"
            ? String(/** @type {Record<string, unknown>} */ (entryVal).path)
            : null;
      if (pathLike !== null) {
        if (path.isAbsolute(pathLike) || /^[A-Za-z]:[\\/]/.test(pathLike)) {
          diagnostics.push({
            code: "absolute_path_rejected",
            message: `${section}.${entryKey} uses absolute path "${pathLike}"`,
            field: `${section}.${entryKey}`,
          });
        }
        if (pathLike.includes("..") || pathLike.includes("\\..")) {
          diagnostics.push({
            code: "path_traversal_rejected",
            message: `${section}.${entryKey} uses path traversal "${pathLike}"`,
            field: `${section}.${entryKey}`,
          });
        }
      }
      // Extension namespaces must be verified reverse-domain IDs (Agent Plugins containment).
      // Bare short keys and non-reverse-domain dotted keys are rejected.
      const verified = /^(com|org|io|net|dev)\.[a-z0-9]+(\.[a-z0-9_-]+)+$/i.test(entryKey);
      if (!verified) {
        diagnostics.push({
          code: "unverified_extension_namespace",
          message: `unverified extension namespace "${entryKey}" in ${section}`,
          field: `${section}.${entryKey}`,
        });
      }
    }
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }
  return { ok: true, name: "bearing-lite", schema: SCHEMA_V1 };
}

describe("CMD-MANIFEST-01 plugin-manifest (SEIT-MANIFEST-01, SEIT-EXTENSION-01)", () => {
  it("loads product plugin.json with exact v1.0.0 schema and bearing-lite name", () => {
    const raw = readFileSync(path.join(ROOT, "plugin.json"), "utf8");
    const manifest = JSON.parse(raw);
    assert.equal(manifest.$schema, SCHEMA_V1);
    assert.equal(manifest.name, "bearing-lite");
    const verdict = validatePluginManifest(manifest);
    assert.equal(verdict.ok, true, JSON.stringify(verdict));
    if (verdict.ok) {
      assert.equal(verdict.schema, SCHEMA_V1);
      assert.equal(verdict.name, "bearing-lite");
    }
  });

  it("accepts only closed top-level fields present on the product manifest", () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "plugin.json"), "utf8"));
    for (const key of Object.keys(manifest)) {
      assert.ok(
        CLOSED_TOP_LEVEL.has(key),
        `product field "${key}" is outside the documented closed set`
      );
    }
  });

  it("keeps host install metadata aligned with Bearing Lite", () => {
    const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), "utf8"));
    const claude = readJson(".claude-plugin/plugin.json");
    const codex = readJson(".codex-plugin/plugin.json");
    const grok = readJson(".grok-plugin/plugin.json");
    const cursor = readJson(".cursor-plugin/plugin.json");
    const kimi = readJson(".kimi-plugin/plugin.json");
    const agy = readJson(".agy/plugin.json");
    const pkg = readJson("package.json");

    for (const manifest of [claude, codex, grok, cursor, kimi]) {
      assert.equal(manifest.name, "bearing-lite");
      assert.equal(manifest.skills, "./skills/");
      assert.equal(manifest.mcpServers, undefined);
    }
    for (const manifest of [claude, codex, grok]) {
      // These hosts auto-load hooks/hooks.json. Declaring both duplicates.
      assert.equal(manifest.hooks, undefined);
    }
    assert.equal(cursor.hooks, "./hooks/com.cursor/hooks.json");
    assert.ok(Array.isArray(kimi.hooks));
    assert.equal(kimi.hooks.length, 2);
    assert.deepEqual(Object.keys(agy).sort(), ["description", "name"]);
    assert.equal(agy.name, "bearing-lite");
    assert.deepEqual(pkg.pi, { skills: ["./skills"] });
    assert.ok(pkg.keywords.includes("pi-package"));

    const portable = readJson("plugin.json");
    assert.deepEqual(Object.keys(portable.hooks).sort(), [
      "com.anthropic.claude-code.activation",
      "com.anthropic.claude-code.closeout",
      "com.cursor.ide.activation",
      "com.cursor.ide.closeout",
      "com.moonshotai.kimi-code.activation",
      "com.moonshotai.kimi-code.closeout",
      "com.openai.codex.activation",
      "com.openai.codex.closeout",
      "com.xai.grok-build.activation",
      "com.xai.grok-build.closeout",
    ]);
    for (const entry of Object.values(portable.hooks)) {
      assert.equal(entry.path, "./hooks/com.anthropic.claude-code/host.cjs");
    }

    assert.equal(readJson(".agents/plugins/marketplace.json").plugins[0].name, "bearing-lite");
    assert.equal(readJson(".claude-plugin/marketplace.json").plugins[0].name, "bearing-lite");
    assert.equal(readJson(".grok-plugin/marketplace.json").plugins[0].name, "bearing-lite");
    assert.equal(readJson(".cursor-plugin/marketplace.json").plugins[0].name, "bearing-lite");
  });

  it("negative: floating / non-1.0.0 schema is rejected with typed diagnostic", () => {
    const fixture = {
      $schema: "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json",
      name: "bearing-lite",
      version: "0.1.0",
    };
    const verdict = validatePluginManifest(fixture);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.ok(
        verdict.diagnostics.some((d) => d.code === "schema_not_v1_0_0"),
        "expected schema_not_v1_0_0"
      );
    }
  });

  it("negative: unknown top-level field is rejected with typed diagnostic", () => {
    const fixture = {
      $schema: SCHEMA_V1,
      name: "bearing-lite",
      version: "0.1.0",
      secretRuntimeBridge: true,
    };
    const verdict = validatePluginManifest(fixture);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      const hit = verdict.diagnostics.find((d) => d.code === "unknown_top_level_field");
      assert.ok(hit, "expected unknown_top_level_field");
      assert.equal(hit.field, "secretRuntimeBridge");
    }
  });

  it("negative: absolute path in extension map is rejected", () => {
    const fixture = {
      $schema: SCHEMA_V1,
      name: "bearing-lite",
      version: "0.1.0",
      hooks: {
        "com.example.vendor.hook": { path: "/etc/passwd" },
      },
    };
    const verdict = validatePluginManifest(fixture);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.ok(
        verdict.diagnostics.some((d) => d.code === "absolute_path_rejected"),
        "expected absolute_path_rejected"
      );
    }
  });

  it("negative: path traversal is rejected", () => {
    const fixture = {
      $schema: SCHEMA_V1,
      name: "bearing-lite",
      version: "0.1.0",
      hooks: {
        "com.example.vendor.hook": { path: "../../secrets/token" },
      },
    };
    const verdict = validatePluginManifest(fixture);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.ok(
        verdict.diagnostics.some((d) => d.code === "path_traversal_rejected"),
        "expected path_traversal_rejected"
      );
    }
  });

  it("negative: unverified extension namespace is rejected", () => {
    const fixture = {
      $schema: SCHEMA_V1,
      name: "bearing-lite",
      version: "0.1.0",
      hooks: {
        "not-a-reverse-domain": { path: "./hooks/x.cjs" },
      },
    };
    const verdict = validatePluginManifest(fixture);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.ok(
        verdict.diagnostics.some((d) => d.code === "unverified_extension_namespace"),
        "expected unverified_extension_namespace"
      );
    }
  });
});
