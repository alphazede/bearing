import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setBearingsWorkspace } from "../src/journey/repository-map.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bearing-repository-map-"));
  roots.push(root);
  await writeFile(join(root, "sentinel.bin"), Buffer.from([0, 1, 2, 255]));
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

describe("Set Bearings workspace", () => {
  it("leaves the directory tree byte-identical without a confirmed path", async () => {
    const root = await repository();
    const before = await tree(root);

    expect(await setBearingsWorkspace(root, "Do not create anything")).toBeUndefined();
    expect(await tree(root)).toEqual(before);
  });

  it("creates exactly the confirmed absent path", async () => {
    const root = await repository();
    const path = "docs/plans/bearing-improvements/phase-2a";

    expect(await setBearingsWorkspace(root, "Bearing improvements", path)).toMatchObject({
      directory: path,
      artifacts: [`${path}/prompts/repository-map.md`, `${path}/plan-spec.md`],
      resumed: false,
    });
    expect((await tree(root)).filter((entry) => entry.endsWith("/"))).toEqual([
      "docs/",
      "docs/plans/",
      "docs/plans/bearing-improvements/",
      "docs/plans/bearing-improvements/phase-2a/",
      "docs/plans/bearing-improvements/phase-2a/prompts/",
    ]);
  });

  it("resumes the confirmed existing path without changing its plan stub", async () => {
    const root = await repository();
    const path = "docs/plans/2026-07-24-existing-plan";
    const stub = Buffer.from("existing plan bytes\r\n", "utf8");
    await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, path, "plan-spec.md"), stub);
    const beforeDirectories = (await tree(root)).filter((entry) => entry.endsWith("/"));

    expect(await setBearingsWorkspace(root, "Different goal text", path)).toMatchObject({
      directory: path,
      resumed: true,
    });
    expect(await readFile(join(root, path, "plan-spec.md"))).toEqual(stub);
    expect((await tree(root)).filter((entry) => entry.endsWith("/"))).toEqual([
      ...beforeDirectories,
      `${path}/prompts/`,
    ].sort());
  });

  it("rejects a symlinked plan artifact without changing the repository", async () => {
    const root = await repository();
    const path = "docs/plans/shared";
    await writeFile(join(root, "package.json"), '{"name":"victim"}\n');
    await mkdir(join(root, path), { recursive: true });
    await symlink("../../../package.json", join(root, path, "plan-spec.md"));
    const before = await tree(root);

    expect(await setBearingsWorkspace(root, "Shared plan", path)).toBeUndefined();
    expect(await tree(root)).toEqual(before);
  });

  it("uses the relaxed predicate and contains no collision search", async () => {
    const source = await readFile(new URL("../src/journey/repository-map.ts", import.meta.url), "utf8");
    expect(source).toContain("planDirectoryValid(existingDirectory)");
    expect(source).not.toMatch(/while\s*\(\s*true\s*\)|suffix\s*\+=|\\d\{4\}-\\d\{2\}-\\d\{2\}/);
  });
});
