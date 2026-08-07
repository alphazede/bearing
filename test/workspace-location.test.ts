import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  isVisibleWorkspaceName,
  planWorkspaceName,
  planWorkspacePath,
  visibleWorkspaces,
  workspaceRelativePath,
} from "../src/repository/workspace-location.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "bearing-workspace-location-"));
  roots.push(value);
  return value;
}

describe("planWorkspaceName", () => {
  it("derives the workspace name from the plan directory basename", () => {
    expect(planWorkspaceName("docs/plans/2026-08-06-migrate-state")).toBe("bearing-2026-08-06-migrate-state");
    expect(planWorkspaceName("docs/plans/a")).toBe("bearing-a");
  });

  it("derives distinct workspaces from every segment of multi-segment plan directories", () => {
    expect(planWorkspaceName("docs/plans/alpha/impl")).toBe("bearing-alpha-impl");
    expect(planWorkspaceName("docs/plans/beta/impl")).toBe("bearing-beta-impl");
    expect(planWorkspaceName("docs/plans/2026-08-06/a/b")).toBe("bearing-2026-08-06-a-b");
  });

  it("rejects a valid plan directory whose joined workspace name exceeds the visible grammar", () => {
    const overLong = `docs/plans/${"x".repeat(64)}/y`;
    expect(() => planWorkspaceName(overLong)).toThrow(/over-long/);
  });

  it("rejects plan directories that fail the plan directory rules", () => {
    for (const invalid of ["", "relative", "/absolute", "docs/plans/a b", "docs/plans/../escape", "docs/plans/a/b/c/d"]) {
      expect(() => planWorkspaceName(invalid)).toThrow(/Plan directory is not valid/);
    }
  });
});

describe("planWorkspacePath", () => {
  it("joins the repository root with the derived workspace name", () => {
    expect(planWorkspacePath("/repo", "docs/plans/alpha")).toBe(join("/repo", "bearing-alpha"));
  });
});

describe("isVisibleWorkspaceName", () => {
  it("accepts only the reserved single-segment namespace", () => {
    expect(isVisibleWorkspaceName("bearing-alpha")).toBe(true);
    expect(isVisibleWorkspaceName("bearing-2026-08-06-migrate-state")).toBe(true);
    expect(isVisibleWorkspaceName("bearing-" + "x".repeat(64))).toBe(true);
    for (const invalid of ["bearing-", "bearing-..", "bearing-a/b", "bearing-a\\b", "other", ".bearing", "BEARING-a", "bearing-" + "x".repeat(65)]) {
      expect(isVisibleWorkspaceName(invalid)).toBe(false);
    }
  });
});

describe("visibleWorkspaces", () => {
  it("reports only real non-symlink directories in the reserved namespace", async () => {
    const dir = await root();
    await mkdir(join(dir, "bearing-alpha"));
    await mkdir(join(dir, "bearing-beta"));
    await mkdir(join(dir, "plain"));
    await writeFile(join(dir, "bearing-file"), "x");
    await symlink(join(dir, "bearing-alpha"), join(dir, "bearing-link"));

    expect(await visibleWorkspaces(dir)).toEqual(["bearing-alpha", "bearing-beta"]);
  });

  it("is empty for an unreadable or absent repository root", async () => {
    expect(await visibleWorkspaces(join(await root(), "missing"))).toEqual([]);
  });

  it("rethrows a non-ENOENT readdir failure instead of reporting an empty set", async () => {
    const dir = await root();
    await writeFile(join(dir, "blocker"), "x");
    // A regular file as a path component makes readdir fail with ENOTDIR. Only an absent
    // repository root (ENOENT) may read as an empty workspace: a transient failure like
    // EACCES must surface, or load() returns a blank run and a legacy write later creates
    // a permanent run_location_conflict.
    await expect(visibleWorkspaces(join(dir, "blocker", "missing"))).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(await visibleWorkspaces(join(dir, "missing"))).toEqual([]);
  });

  it("returns a stable sorted order", async () => {
    const dir = await root();
    await mkdir(join(dir, "bearing-c"));
    await mkdir(join(dir, "bearing-a"));
    await mkdir(join(dir, "bearing-b"));
    expect(await visibleWorkspaces(dir)).toEqual(["bearing-a", "bearing-b", "bearing-c"]);
  });
});

describe("workspaceRelativePath", () => {
  it("returns the POSIX repository-relative path of a contained workspace path", () => {
    expect(workspaceRelativePath("/repo", "/repo/bearing-alpha/runs/run-1")).toBe("bearing-alpha/runs/run-1");
  });

  it("returns undefined for uncontained, empty, or non-normal paths", () => {
    expect(workspaceRelativePath("/repo", "/elsewhere/bearing-alpha")).toBeUndefined();
    expect(workspaceRelativePath("/repo", "/repo")).toBeUndefined();
    expect(workspaceRelativePath("/repo", "/repo/bearing-alpha\\runs\\run-1")).toBeUndefined();
    expect(workspaceRelativePath("/repo", "/repo/bearing-alpha/../other")).toBeUndefined();
  });
});
