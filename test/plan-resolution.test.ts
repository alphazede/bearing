import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyConsolidation,
  planConsolidation,
  resolvePlanDirectory,
} from "../src/journey/plan-resolution.js";
import { planDirectoryValid } from "../src/journey/plan-directory.js";
import { JourneyService, type JourneyRequest } from "../src/journey/planning-journey.js";
import { setBearingsWorkspace } from "../src/journey/repository-map.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(prefix = "bearing-plan-resolution-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function tree(root: string): Promise<readonly string[]> {
  const rows: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        rows.push(`${path}/`);
        await visit(join(directory, entry.name), path);
      } else {
        rows.push(`${path}:${(await readFile(join(directory, entry.name))).toString("base64")}`);
      }
    }
  };
  await visit(root, "");
  return rows.sort();
}

async function files(root: string, directory: string, values: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, content] of Object.entries(values)) {
    await mkdir(join(root, directory, path, ".."), { recursive: true });
    await writeFile(join(root, directory, path), content);
  }
}

function setBearingsRequest(repositoryPath: string, requestedPlanDirectory: string): JourneyRequest {
  const selection = { provider: "codex", model: "*", reasoning: "medium" } as const;
  return {
    selection,
    run: {
      roles: [{ role: "crewmate", executor: true, authority: { write: true }, selection }],
    } as unknown as JourneyRequest["run"],
    repositoryPath,
    runId: "resolution-journey",
    workGoal: "Resume the explicitly selected plan",
    stage: "set-bearings",
    priorOwnerQa: [],
    requestedPlanDirectory,
  };
}

function localJourney(resolver?: typeof resolvePlanDirectory): JourneyService {
  return new JourneyService({
    executableAvailable: () => true,
    run: async () => { throw new Error("Set Bearings must not invoke an agent"); },
  }, resolver);
}

describe("plan directory resolution", () => {
  it("resolves a full path and exact bare final segment to the same directory", async () => {
    const root = await repository();
    const path = "docs/plans/platform/auth/rotation";
    await mkdir(join(root, path), { recursive: true });

    expect(await resolvePlanDirectory(root, path)).toEqual({ ok: true, path, exists: true });
    expect(await resolvePlanDirectory(root, "rotation")).toEqual({ ok: true, path, exists: true });
    expect(await resolvePlanDirectory(root, "Rotation")).toEqual({
      ok: false,
      reason: "plan_directory_absent",
      requested: "Rotation",
    });
  });

  it("returns typed full-path creation and bare-name absence without guessing", async () => {
    const root = await repository();
    await mkdir(join(root, "docs/plans"), { recursive: true });
    const path = "docs/plans/platform/auth/new-rotation";

    expect(await resolvePlanDirectory(root, path)).toEqual({ ok: true, path, exists: false });
    expect(await resolvePlanDirectory(root, "new-rotation")).toEqual({
      ok: false,
      reason: "plan_directory_absent",
      requested: "new-rotation",
    });
  });

  it("returns every exact ambiguous match without changing the tree", async () => {
    const root = await repository();
    await Promise.all([
      mkdir(join(root, "docs/plans/one/shared"), { recursive: true }),
      mkdir(join(root, "docs/plans/two/shared"), { recursive: true }),
    ]);
    const before = await tree(root);

    expect(await resolvePlanDirectory(root, "shared")).toEqual({
      ok: false,
      reason: "plan_directory_ambiguous",
      matches: ["docs/plans/one/shared", "docs/plans/two/shared"],
    });
    expect(await tree(root)).toEqual(before);
  });

  it("rejects invalid, non-directory, and symlinked full paths", async () => {
    const root = await repository();
    const outside = await repository("bearing-plan-resolution-outside-");
    await mkdir(join(root, "docs/plans"), { recursive: true });
    await writeFile(join(root, "docs/plans/not-a-directory"), "file");
    await symlink(outside, join(root, "docs/plans/link"));

    for (const path of [
      "docs/plans/has space",
      "docs/plans/not-a-directory",
      "docs/plans/not-a-directory/child",
      "docs/plans/link",
    ]) {
      expect(await resolvePlanDirectory(root, path)).toEqual({
        ok: false,
        reason: "plan_directory_invalid",
      });
    }
  });

  it("rejects paths whose canonical form escapes the plan-directory grammar", async () => {
    const root = await repository();
    await mkdir(join(root, "documentation/plans/foo"), { recursive: true });
    await symlink("documentation", join(root, "docs"));

    const resolution = await resolvePlanDirectory(root, "docs/plans/foo");
    expect(resolution).toEqual({ ok: false, reason: "plan_directory_invalid" });
    if (resolution.ok) expect(planDirectoryValid(resolution.path)).toBe(true);
  });

  it("rejects a symlinked ancestor whether or not the leaf exists", async () => {
    const root = await repository();
    await mkdir(join(root, "docs/plans/actual/x"), { recursive: true });
    await symlink("actual", join(root, "docs/plans/link"));

    const resolutions = await Promise.all(
      ["docs/plans/link/x", "docs/plans/link/new"].map((path) => resolvePlanDirectory(root, path)),
    );
    expect(resolutions).toEqual([
      { ok: false, reason: "plan_directory_invalid" },
      { ok: false, reason: "plan_directory_invalid" },
    ]);
    for (const resolution of resolutions) {
      if (resolution.ok) expect(planDirectoryValid(resolution.path)).toBe(true);
    }
  });

  it("reproduces the named dated-plan case without creating a sibling", async () => {
    const root = await repository();
    const name = "2026-07-22-bran-okf-final-cutover";
    const path = `docs/plans/${name}`;
    await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, path, "plan-spec.md"), "existing\n");
    const before = await readdir(join(root, "docs/plans"));

    const resolution = await resolvePlanDirectory(root, name);
    expect(resolution).toEqual({ ok: true, path, exists: true });
    if (!resolution.ok) throw new Error(resolution.reason);
    expect(await setBearingsWorkspace(root, "Create or resume the plan", resolution.path)).toMatchObject({
      directory: path,
      resumed: true,
    });
    expect(await readdir(join(root, "docs/plans"))).toEqual(before);
  });

  it("resolves owner-named directories that repository surveys omit", async () => {
    const root = await repository();
    const names = ["2026-07-22-token-rotation", "build"];
    for (const name of names) {
      await mkdir(join(root, "docs/plans", name), { recursive: true });
    }
    expect(await Promise.all(names.map((name) => resolvePlanDirectory(root, name)))).toEqual(
      names.map((name) => ({ ok: true, path: `docs/plans/${name}`, exists: true })),
    );
  });

  it("resumes an explicitly named existing directory through the journey without a sibling", async () => {
    const root = await repository();
    const name = "2026-07-22-bran-okf-final-cutover";
    const path = `docs/plans/${name}`;
    const existing = Buffer.from("existing plan bytes\r\n", "utf8");
    await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, path, "plan-spec.md"), existing);
    const beforeSiblings = await readdir(join(root, "docs/plans"));
    const service = localJourney();

    expect(await service.execute(setBearingsRequest(root, name))).toMatchObject({
      status: "action",
      summary: "Bearings resumed locally.",
      artifacts: [`${path}/prompts/repository-map.md`, `${path}/plan-spec.md`],
    });
    expect(await readdir(join(root, "docs/plans"))).toEqual(beforeSiblings);
    expect(await readFile(join(root, path, "plan-spec.md"))).toEqual(existing);
  });

  it("returns typed ambiguity and escape stops before journey mutation or phase advance", async () => {
    const ambiguousRoot = await repository();
    await Promise.all([
      mkdir(join(ambiguousRoot, "docs/plans/one/shared"), { recursive: true }),
      mkdir(join(ambiguousRoot, "docs/plans/two/shared"), { recursive: true }),
    ]);
    const ambiguousBefore = await tree(ambiguousRoot);
    const ambiguousService = localJourney();

    expect(await ambiguousService.execute(setBearingsRequest(ambiguousRoot, "shared"))).toEqual({
      status: "failure",
      code: "plan_directory_ambiguous",
      tokens: 0,
    });
    expect(await tree(ambiguousRoot)).toEqual(ambiguousBefore);
    expect(ambiguousService.activityTrail("resolution-journey")).toEqual([]);

    const escapeRoot = await repository();
    const escapeBefore = await tree(escapeRoot);
    const escapeService = localJourney();

    expect(await escapeService.execute(setBearingsRequest(escapeRoot, "docs/plans/../../escape"))).toEqual({
      status: "failure",
      code: "plan_directory_invalid",
      tokens: 0,
    });
    expect(await tree(escapeRoot)).toEqual(escapeBefore);
    expect(escapeService.activityTrail("resolution-journey")).toEqual([]);
  });

  it("fails closed when the bounded inventory cannot inspect every exact-name candidate", async () => {
    const root = await repository();
    await Promise.all([
      mkdir(join(root, "docs/plans/a/shared"), { recursive: true }),
      mkdir(join(root, "docs/plans/z/shared"), { recursive: true }),
    ]);
    await Promise.all(Array.from({ length: 198 }, (_, index) =>
      writeFile(join(root, "docs/plans", `b${String(index).padStart(3, "0")}.txt`), "filler\n"),
    ));
    const before = await tree(root);
    const service = localJourney();

    expect(await service.execute(setBearingsRequest(root, "shared"))).toEqual({
      status: "failure",
      code: "plan_directory_invalid",
      tokens: 0,
    });
    expect(await tree(root)).toEqual(before);
    expect(service.activityTrail("resolution-journey")).toEqual([]);
  });

  it("accepts an exactly complete inventory at the path boundary", async () => {
    const root = await repository();
    const path = "docs/plans/z-target";
    await mkdir(join(root, path), { recursive: true });
    await Promise.all(Array.from({ length: 199 }, (_, index) =>
      writeFile(join(root, "docs/plans", `a${String(index).padStart(3, "0")}.txt`), "filler\n"),
    ));

    expect(await localJourney().execute(setBearingsRequest(root, "z-target"))).toMatchObject({
      status: "action",
      summary: "Bearings resumed locally.",
      artifacts: [`${path}/prompts/repository-map.md`, `${path}/plan-spec.md`],
    });
  });

  it("keeps an ignored symlink cap-neutral after exactly 200 eligible paths", async () => {
    const root = await repository();
    const path = "docs/plans/z-target";
    await mkdir(join(root, path), { recursive: true });
    await Promise.all(Array.from({ length: 199 }, (_, index) =>
      writeFile(join(root, "docs/plans", `a${String(index).padStart(3, "0")}.txt`), "filler\n"),
    ));
    await symlink("a000.txt", join(root, "docs/plans/zz-ignored"));
    const before = await tree(root);

    expect(await resolvePlanDirectory(root, "z-target")).toEqual({ ok: true, path, exists: true });
    expect(await tree(root)).toEqual(before);
  });

  it("ignores empty content deeper than the bare-name matching depth", async () => {
    const root = await repository();
    const path = "docs/plans/z-target";
    await Promise.all([
      mkdir(join(root, path), { recursive: true }),
      mkdir(join(root, "docs/plans/a/b/c/d/e"), { recursive: true }),
    ]);

    expect(await localJourney().execute(setBearingsRequest(root, "z-target"))).toMatchObject({
      status: "action",
      summary: "Bearings resumed locally.",
    });
  });

  it("returns a typed stop when its resolver throws before journey activity or mutation", async () => {
    const root = await repository();
    const before = await tree(root);
    const service = localJourney(async () => { throw new Error("simulated resolver failure"); });

    expect(await service.execute(setBearingsRequest(root, "shared"))).toEqual({
      status: "failure",
      code: "plan_directory_invalid",
      tokens: 0,
    });
    expect(await tree(root)).toEqual(before);
    expect(service.activityTrail("resolution-journey")).toEqual([]);
  });
});

describe("plan consolidation", () => {
  it("copies absent files, skips identical files, and leaves sources intact", async () => {
    const root = await repository();
    const canonical = "docs/plans/canonical";
    const sources = ["docs/plans/duplicate-a", "docs/plans/duplicate-b"];
    await files(root, canonical, { "same.md": "same\n" });
    await files(root, sources[0], {
      "same.md": "same\n",
      "copy.md": "copy\n",
      "nested/evidence.txt": "evidence\n",
    });
    await files(root, sources[1], { "copy.md": "copy\n" });
    const sourceTrees = await Promise.all(sources.map((source) => tree(join(root, source))));

    const plan = await planConsolidation(root, canonical, sources);
    expect(plan.ok).toBe(true);
    expect(plan.entries.map(({ action }) => action)).toEqual(["copy", "copy", "skip", "skip"]);
    expect(await applyConsolidation(root, plan)).toEqual({
      ok: true,
      copied: [
        "docs/plans/canonical/copy.md",
        "docs/plans/canonical/nested/evidence.txt",
      ],
      skipped: [
        "docs/plans/canonical/same.md",
        "docs/plans/canonical/copy.md",
      ],
      sources,
    });
    expect(await readFile(join(root, canonical, "copy.md"), "utf8")).toBe("copy\n");
    expect(await readFile(join(root, canonical, "nested/evidence.txt"), "utf8")).toBe("evidence\n");
    expect(await Promise.all(sources.map((source) => tree(join(root, source))))).toEqual(sourceTrees);
  });

  it("reports conflicts and applies nothing", async () => {
    const root = await repository();
    const canonical = "docs/plans/canonical";
    const sources = ["docs/plans/duplicate"];
    await files(root, canonical, { "conflict.md": "canonical\n" });
    await files(root, sources[0], {
      "conflict.md": "different\n",
      "would-copy.md": "must not appear\n",
    });
    const before = await tree(root);

    const plan = await planConsolidation(root, canonical, sources);
    expect(plan).toMatchObject({ ok: false, reason: "consolidation_conflict" });
    expect(await tree(root)).toEqual(before);
    expect(await applyConsolidation(root, plan)).toEqual({
      ok: false,
      reason: "consolidation_conflict",
      sources,
    });
    expect(await tree(root)).toEqual(before);
  });

  it("never applies a source whose bounded inventory omitted files", async () => {
    const root = await repository();
    const canonical = "docs/plans/canonical";
    const sources = ["docs/plans/duplicate"];
    await Promise.all([
      mkdir(join(root, canonical), { recursive: true }),
      mkdir(join(root, sources[0]), { recursive: true }),
    ]);
    await Promise.all(Array.from({ length: 201 }, (_, index) =>
      writeFile(join(root, sources[0], `f${String(index).padStart(3, "0")}.md`), "source\n"),
    ));
    const before = await tree(root);

    const plan = await planConsolidation(root, canonical, sources);
    expect(plan).toEqual({ ok: false, reason: "consolidation_conflict", canonical, sources, entries: [] });
    expect(await applyConsolidation(root, plan)).toEqual({ ok: false, reason: "consolidation_conflict", sources });
    expect(await tree(root)).toEqual(before);
  });

  it("keeps an ignored source symlink cap-neutral after exactly 200 eligible paths", async () => {
    const root = await repository();
    const canonical = "docs/plans/canonical";
    const sources = ["docs/plans/duplicate"];
    await Promise.all([
      mkdir(join(root, canonical), { recursive: true }),
      mkdir(join(root, sources[0]), { recursive: true }),
    ]);
    await Promise.all(Array.from({ length: 200 }, (_, index) =>
      writeFile(join(root, sources[0], `a${String(index).padStart(3, "0")}.md`), "source\n"),
    ));
    await symlink("a000.md", join(root, sources[0], "zz-ignored"));

    const plan = await planConsolidation(root, canonical, sources);
    expect(plan).toMatchObject({ ok: true, canonical, sources });
    expect(plan.entries).toHaveLength(200);
  });

  it("plans files and directories that repository surveys omit", async () => {
    const root = await repository();
    const canonical = "docs/plans/canonical";
    const sources = ["docs/plans/duplicate"];
    await files(root, canonical, { "token-rotation.md": "canonical\n" });
    await files(root, sources[0], {
      "build/result.md": "copy\n",
      "token-rotation.md": "different\n",
    });

    expect(await planConsolidation(root, canonical, sources)).toMatchObject({
      ok: false,
      reason: "consolidation_conflict",
      entries: [
        { action: "copy", source: "docs/plans/duplicate/build/result.md", destination: "docs/plans/canonical/build/result.md" },
        { action: "conflict", source: "docs/plans/duplicate/token-rotation.md", destination: "docs/plans/canonical/token-rotation.md" },
      ],
    });
  });

  it("contains no destructive filesystem call", async () => {
    const source = await readFile(new URL("../src/journey/plan-resolution.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\b(?:unlink|rm|truncate|rename)\s*\(/);
  });
});
