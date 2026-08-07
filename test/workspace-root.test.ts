import { describe, expect, it } from "vitest";
import { mkdir, rename, rm, symlink, writeFile, lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  pinWorkspaceRoot,
  assertWorkspaceRoot,
  assertContained,
  safeRollbackCreatedDirectory,
  isWorkspaceRootError,
  WorkspaceRootError,
} from "../src/repository/workspace-root.js";

describe("workspace-root authority", () => {
  it("pins valid workspace root and asserts successfully", async () => {
    const repo = join(tmpdir(), `test-wsroot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const bearing = join(repo, ".bearing");
    await mkdir(bearing, { recursive: true });

    try {
      const pinned = await pinWorkspaceRoot(repo);
      expect(pinned.repositoryPath).toBe(await realpath(repo));
      expect(pinned.workspacePath).toBe(bearing);
      expect(pinned.dev).toBeGreaterThan(0);
      expect(pinned.ino).toBeGreaterThan(0);

      await expect(assertWorkspaceRoot(pinned)).resolves.toBeUndefined();
      await expect(assertContained(pinned, join(bearing, "runs"))).resolves.toBeDefined();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("refuses .bearing symlink swap", async () => {
    const repo = join(tmpdir(), `test-wsroot-symlink-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const target = join(tmpdir(), `test-wsroot-target-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const bearing = join(repo, ".bearing");
    await mkdir(repo, { recursive: true });
    await mkdir(target, { recursive: true });
    await symlink(target, bearing);

    try {
      await expect(pinWorkspaceRoot(repo)).rejects.toThrow(WorkspaceRootError);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
    }
  });

  it("refuses regular file .bearing workspace root", async () => {
    const repo = join(tmpdir(), `test-wsroot-file-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const bearing = join(repo, ".bearing");
    await mkdir(repo, { recursive: true });
    await writeFile(bearing, "not a directory");

    try {
      await expect(pinWorkspaceRoot(repo)).rejects.toThrow(WorkspaceRootError);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("detects identity mismatch when .bearing is replaced with another directory", async () => {
    const repo = join(tmpdir(), `test-wsroot-replaced-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const bearing = join(repo, ".bearing");
    const other = join(repo, ".bearing-other");
    await mkdir(bearing, { recursive: true });
    await mkdir(other, { recursive: true });

    try {
      const pinned = await pinWorkspaceRoot(repo);

      // Replace .bearing with another directory (guaranteed different inode)
      await rm(bearing, { recursive: true, force: true });
      await rename(other, bearing);

      await expect(assertWorkspaceRoot(pinned)).rejects.toThrow(WorkspaceRootError);
      expect(isWorkspaceRootError(new WorkspaceRootError("test"))).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(other, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("preserves external targets during containment rollback", async () => {
    const repo = join(tmpdir(), `test-wsroot-rollback-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const external = join(tmpdir(), `test-external-target-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const bearing = join(repo, ".bearing");
    await mkdir(bearing, { recursive: true });
    await mkdir(external, { recursive: true });
    await writeFile(join(external, "keep.txt"), "valuable");

    try {
      const pinned = await pinWorkspaceRoot(repo);

      // Attempt rollback on external path: must NOT delete external directory or its contents!
      await safeRollbackCreatedDirectory(pinned, external);

      const st = await lstat(join(external, "keep.txt")).catch(() => null);
      expect(st).not.toBeNull();
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });

  it("deletes operation-created directory within workspace on rollback", async () => {
    const repo = join(tmpdir(), `test-wsroot-rollback-ok-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const bearing = join(repo, ".bearing");
    await mkdir(bearing, { recursive: true });

    try {
      const pinned = await pinWorkspaceRoot(repo);
      const created = join(bearing, "tmp-created-dir");
      await mkdir(created, { recursive: true });

      await safeRollbackCreatedDirectory(pinned, created);

      const st = await lstat(created).catch(() => null);
      expect(st).toBeNull();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
