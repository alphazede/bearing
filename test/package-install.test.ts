import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const roots: string[] = [];
const repository = new URL("..", import.meta.url);
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function assertInstall(root: string): Promise<void> {
  await Promise.all([
    access(join(root, "dist/cli.js")),
    access(join(root, ".codex-plugin/plugin.json")),
    access(join(root, ".claude-plugin/plugin.json")),
    access(join(root, "plugin-skills/bearing/SKILL.md")),
    access(join(root, "plugin-skills/explorer/SKILL.md")),
    access(join(root, "plugin-skills/navigator/SKILL.md")),
    access(join(root, "plugin-skills/crewmate/SKILL.md")),
    access(join(root, "skills/crewmate/SKILL.md")),
    access(join(root, "hooks/focus-reminder.cjs")),
  ]);
  await expect(exec("bearing", ["--version"], { cwd: root, env: { PATH: join(root, "empty-path") } })).rejects.toMatchObject({ code: "ENOENT" });
  const fallback: { code?: number; stderr?: string } = await exec(process.execPath, [join(root, "dist/cli.js"), "bogus"], { cwd: root, env: { PATH: join(root, "empty-path") } })
    .then(({ stderr }) => ({ stderr }))
    .catch((error: unknown) => error as { code?: number; stderr?: string });
  expect(fallback.code).toBe(2);
  expect(fallback.stderr).toContain("usage: bearing");
  const internalSkill = await readFile(join(root, "skills/crewmate/SKILL.md"), "utf8");
  expect(internalSkill).toContain("user-invocable: false");
  expect(internalSkill).toContain("disable-model-invocation: true");
}

describe("packaged plugin installation", () => {
  it("runs from a fresh indexed Git source archive with no global CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-git-install-"));
    roots.push(root);
    const { stdout: tree } = await exec("git", ["write-tree"], { cwd: repository });
    const archive = join(root, "bearing.tar");
    await exec("git", ["archive", "--format=tar", `--output=${archive}`, tree.trim()], { cwd: repository });
    const extracted = join(root, "source");
    await exec("mkdir", [extracted]);
    await exec("tar", ["-xf", archive, "-C", extracted]);
    await assertInstall(extracted);
  });

  it("runs from a fresh npm tarball with guarded skills and runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-npm-install-"));
    roots.push(root);
    const { stdout } = await exec("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], { cwd: repository, maxBuffer: 4 * 1024 * 1024 });
    const packed = JSON.parse(stdout) as { filename: string }[];
    expect(packed).toHaveLength(1);
    const extracted = join(root, "package");
    await exec("tar", ["-xzf", join(root, packed[0].filename), "-C", root]);
    await assertInstall(extracted);
    const packageJson = JSON.parse(await readFile(join(extracted, "package.json"), "utf8"));
    expect(packageJson.bin).toEqual({ bearing: "dist/cli.js" });
  });
});
