import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { RepositoryBootstrap } from "../src/repository/bootstrap.js";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length) {
    const root = roots.pop()!;
    await chmod(root, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bearing-bootstrap-"));
  roots.push(root);
  return root;
}

async function tempRepo(): Promise<string> {
  const root = await tempDir();
  await mkdir(join(root, ".git"));
  return root;
}

async function writeManifest(root: string, body: unknown): Promise<void> {
  await mkdir(join(root, ".bearing"));
  await writeFile(join(root, ".bearing", "workspace.json"), `${JSON.stringify(body)}\n`);
}

describe("RepositoryBootstrap", () => {
  it("atomically initializes and resumes a repository manifest", async () => {
    const root = await tempRepo();
    await writeFile(join(root, ".gitignore"), ".bearing/\n");
    const repositoryPath = await realpath(root);
    const bootstrap = new RepositoryBootstrap();

    const initialized = await bootstrap.choose(root);
    expect(initialized).toEqual({
      ok: true,
      status: "initialized",
      repositoryPath,
      gitignoreMissing: false,
      gitignoreAbsent: false,
    });
    expect(JSON.parse(await readFile(join(root, ".bearing", "workspace.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      repositoryPath,
    });
    expect((await readdir(root)).filter((entry) => entry.startsWith(".bearing.tmp-"))).toEqual([]);

    const resumed = await bootstrap.choose(root);
    expect(resumed).toEqual({ ok: true, status: "resumed", repositoryPath });
  });

  it("blocks non-git initialization until the owner confirms it", async () => {
    const blockedRoot = await tempDir();
    expect(await new RepositoryBootstrap().choose(blockedRoot, {
      agentExecutableRealpaths: [],
    })).toEqual({ ok: false, reason: "repository_not_git" });
    expect(await lstat(join(blockedRoot, ".bearing")).catch((err: unknown) => err)).toMatchObject({
      code: "ENOENT",
    });

    const confirmedRoot = await tempDir();
    expect(await new RepositoryBootstrap().choose(confirmedRoot, {
      ownerConfirmedNonGit: true,
      agentExecutableRealpaths: [],
    })).toMatchObject({
      ok: true,
      status: "initialized",
      gitignoreMissing: false,
    });
  });

  it("always blocks a repository that contains an agent executable", async () => {
    const root = await tempDir();
    const repositoryPath = await realpath(root);
    await writeManifest(root, { schemaVersion: 1, repositoryPath });

    expect(await new RepositoryBootstrap().choose(root, {
      ownerConfirmedNonGit: true,
      agentExecutableRealpaths: [join(root, "bin", "codex")],
    })).toEqual({ ok: false, reason: "repository_contains_agent" });
  });

  it("accepts a git worktree marker file and resumes it normally", async () => {
    const root = await tempDir();
    const repositoryPath = await realpath(root);
    await writeFile(join(root, ".git"), "gitdir: /tmp/worktree\n");
    await writeFile(join(root, ".gitignore"), ".bearing/\n");
    const bootstrap = new RepositoryBootstrap();

    expect(await bootstrap.choose(root, { agentExecutableRealpaths: [] })).toEqual({
      ok: true,
      status: "initialized",
      repositoryPath,
      gitignoreMissing: false,
      gitignoreAbsent: false,
    });
    expect(await bootstrap.choose(root, { agentExecutableRealpaths: [] })).toEqual({
      ok: true,
      status: "resumed",
      repositoryPath,
    });
  });

  it("resumes a valid existing non-git workspace without confirmation", async () => {
    const root = await tempDir();
    const repositoryPath = await realpath(root);
    await writeManifest(root, { schemaVersion: 1, repositoryPath });

    expect(await new RepositoryBootstrap().choose(root, {
      agentExecutableRealpaths: [],
    })).toEqual({ ok: true, status: "resumed", repositoryPath });
  });

  it("reports whether an existing gitignore lacks the .bearing rule on first init", async () => {
    const missingRuleRoot = await tempRepo();
    await writeFile(join(missingRuleRoot, ".gitignore"), "dist/\n");
    expect(await new RepositoryBootstrap().choose(missingRuleRoot, {
      agentExecutableRealpaths: [],
    })).toMatchObject({ ok: true, status: "initialized", gitignoreMissing: true });

    const ignoredRoot = await tempRepo();
    await writeFile(join(ignoredRoot, ".gitignore"), ".bearing/\n");
    expect(await new RepositoryBootstrap().choose(ignoredRoot, {
      agentExecutableRealpaths: [],
    })).toMatchObject({ ok: true, status: "initialized", gitignoreMissing: false });
  });

  it("reports an absent gitignore as absent, never as an addable missing rule", async () => {
    const root = await tempRepo();

    // `gitignoreMissing` drives the browser's "add .bearing/ to .gitignore" consent
    // action, and that endpoint only appends to an existing regular file — it never
    // creates one. Reporting an absent file as missing would offer an action that
    // always fails, so absence must be reported through its own flag.
    expect(await new RepositoryBootstrap().choose(root, {
      agentExecutableRealpaths: [],
    })).toMatchObject({ ok: true, status: "initialized", gitignoreMissing: false, gitignoreAbsent: true });
    expect(await lstat(join(root, ".gitignore")).catch((err: unknown) => err)).toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports an existing gitignore that lacks the rule as missing and not absent", async () => {
    const root = await tempRepo();
    await writeFile(join(root, ".gitignore"), "node_modules/\n");

    expect(await new RepositoryBootstrap().choose(root, {
      agentExecutableRealpaths: [],
    })).toMatchObject({ ok: true, status: "initialized", gitignoreMissing: true, gitignoreAbsent: false });
  });

  it("accepts every literal .bearing ignore spelling and rejects unrelated lines", async () => {
    for (const line of [".bearing", ".bearing/", "/.bearing", "/.bearing/"]) {
      const root = await tempRepo();
      await writeFile(join(root, ".gitignore"), `dist/\n${line}\n`);
      expect(await new RepositoryBootstrap().choose(root, {
        agentExecutableRealpaths: [],
      })).toMatchObject({ ok: true, status: "initialized", gitignoreMissing: false });
    }

    for (const line of [".bearings", "bearing/", "#.bearing", ".bearing/runs"]) {
      const root = await tempRepo();
      await writeFile(join(root, ".gitignore"), `dist/\n${line}\n`);
      expect(await new RepositoryBootstrap().choose(root, {
        agentExecutableRealpaths: [],
      })).toMatchObject({ ok: true, status: "initialized", gitignoreMissing: true });
    }
  });

  it("remembers a validated owner name without changing the workspace manifest", async () => {
    const root = await tempRepo();
    const repositoryPath = await realpath(root);
    const bootstrap = new RepositoryBootstrap();
    await bootstrap.choose(root);
    const manifest = await readFile(join(root, ".bearing", "workspace.json"), "utf8");

    expect(await bootstrap.rememberOwnerName(repositoryPath, "  Smokie  ")).toBe("Smokie");
    expect(await bootstrap.choose(root)).toEqual({ ok: true, status: "resumed", repositoryPath, ownerName: "Smokie" });
    expect(JSON.parse(await readFile(join(root, ".bearing", "owner.json"), "utf8"))).toEqual({ name: "Smokie" });
    expect((await stat(join(root, ".bearing", "owner.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(root, ".bearing", "workspace.json"), "utf8")).toBe(manifest);

    for (const invalid of ["", " ", "x".repeat(81), "bad\nname"]) {
      expect(await bootstrap.rememberOwnerName(repositoryPath, invalid)).toBeUndefined();
    }
    expect((await bootstrap.choose(root))).toMatchObject({ ownerName: "Smokie" });
  });

  it("rejects invalid repository paths before writing", async () => {
    const root = await tempRepo();
    const file = join(root, "not-a-directory");
    await writeFile(file, "");

    expect(await new RepositoryBootstrap().choose("relative")).toEqual({
      ok: false,
      reason: "path_not_absolute",
    });
    expect(await new RepositoryBootstrap().choose(join(root, "missing"))).toEqual({
      ok: false,
      reason: "repository_unavailable",
    });
    expect(await new RepositoryBootstrap().choose(file)).toEqual({
      ok: false,
      reason: "repository_not_directory",
    });
    expect(await readdir(root)).toEqual([".git", "not-a-directory"]);
  });

  it("rejects an unwritable repository without creating .bearing", async () => {
    if (process.getuid?.() === 0) return;
    const root = await tempRepo();
    await chmod(root, 0o500);

    expect(await new RepositoryBootstrap().choose(root)).toEqual({
      ok: false,
      reason: "repository_not_writable",
    });
    expect(await lstat(join(root, ".bearing")).catch((err: unknown) => err)).toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects unsafe or malformed existing .bearing state without overwriting it", async () => {
    const symlinkRoot = await tempRepo();
    const symlinkTarget = join(symlinkRoot, "target");
    await mkdir(symlinkTarget);
    await symlink(symlinkTarget, join(symlinkRoot, ".bearing"));
    expect(await new RepositoryBootstrap().choose(symlinkRoot)).toEqual({
      ok: false,
      reason: "bearing_symlink",
    });
    expect((await lstat(join(symlinkRoot, ".bearing"))).isSymbolicLink()).toBe(true);

    const fileRoot = await tempRepo();
    await writeFile(join(fileRoot, ".bearing"), "keep");
    expect(await new RepositoryBootstrap().choose(fileRoot)).toEqual({
      ok: false,
      reason: "bearing_not_directory",
    });
    expect(await readFile(join(fileRoot, ".bearing"), "utf8")).toBe("keep");

    const malformedRoot = await tempRepo();
    await mkdir(join(malformedRoot, ".bearing"));
    await writeFile(join(malformedRoot, ".bearing", "workspace.json"), "{bad");
    expect(await new RepositoryBootstrap().choose(malformedRoot)).toEqual({
      ok: false,
      reason: "manifest_malformed",
    });
    expect(await readFile(join(malformedRoot, ".bearing", "workspace.json"), "utf8")).toBe("{bad");

    const manifestSymlinkRoot = await tempRepo();
    await mkdir(join(manifestSymlinkRoot, ".bearing"));
    const manifestSymlinkTarget = join(manifestSymlinkRoot, "target.json");
    await writeFile(
      manifestSymlinkTarget,
      JSON.stringify({
        schemaVersion: 1,
        repositoryPath: await realpath(manifestSymlinkRoot),
      }),
    );
    await symlink(
      manifestSymlinkTarget,
      join(manifestSymlinkRoot, ".bearing", "workspace.json"),
    );
    expect(await new RepositoryBootstrap().choose(manifestSymlinkRoot)).toEqual({
      ok: false,
      reason: "manifest_malformed",
    });
    expect(
      (await lstat(join(manifestSymlinkRoot, ".bearing", "workspace.json"))).isSymbolicLink(),
    ).toBe(true);

    const nonRegularManifestRoot = await tempRepo();
    await mkdir(join(nonRegularManifestRoot, ".bearing"));
    await mkdir(join(nonRegularManifestRoot, ".bearing", "workspace.json"));
    expect(await new RepositoryBootstrap().choose(nonRegularManifestRoot)).toEqual({
      ok: false,
      reason: "manifest_malformed",
    });
  });

  it("resumes with additive .bearing contents and manifest fields", async () => {
    const root = await tempRepo();
    const repositoryPath = await realpath(root);
    await writeManifest(root, {
      schemaVersion: 1,
      repositoryPath,
      futureField: true,
    });
    await writeFile(join(root, ".bearing", "future-entry"), "ok");

    expect(await new RepositoryBootstrap().choose(root)).toEqual({
      ok: true,
      status: "resumed",
      repositoryPath,
    });
  });

  it("rejects missing, future, and mismatched manifests", async () => {
    const missingRoot = await tempRepo();
    await mkdir(join(missingRoot, ".bearing"));
    expect(await new RepositoryBootstrap().choose(missingRoot)).toEqual({
      ok: false,
      reason: "manifest_missing",
    });

    const futureRoot = await tempRepo();
    await writeManifest(futureRoot, {
      schemaVersion: 2,
      repositoryPath: await realpath(futureRoot),
    });
    expect(await new RepositoryBootstrap().choose(futureRoot)).toEqual({
      ok: false,
      reason: "manifest_future_schema",
    });

    const mismatchRoot = await tempRepo();
    await writeManifest(mismatchRoot, {
      schemaVersion: 1,
      repositoryPath: "/tmp/other-repository",
    });
    expect(await new RepositoryBootstrap().choose(mismatchRoot)).toEqual({
      ok: false,
      reason: "manifest_repository_mismatch",
    });
  });

  it("reports interrupted initialization without deleting stale temporary state", async () => {
    const root = await tempRepo();
    const stale = join(root, ".bearing.tmp-stale");
    await mkdir(stale);

    expect(await new RepositoryBootstrap().choose(root)).toEqual({
      ok: false,
      reason: "interrupted_initialization",
    });
    expect((await lstat(stale)).isDirectory()).toBe(true);
    expect(await lstat(join(root, ".bearing")).catch((err: unknown) => err)).toMatchObject({
      code: "ENOENT",
    });
  });
});
