import { lstat, readdir, realpath } from "node:fs/promises";
import { join, posix } from "node:path";
import { planDirectoryValid } from "../journey/plan-directory.js";

const VISIBLE_WORKSPACE_PREFIX = "bearing-";

/**
 * Visible per-plan workspace names are single segments derived from a plan
 * directory's segments after `docs/plans/`, joined with "-", so they inherit
 * the plan segment charset ([A-Za-z0-9._-], at most 64 characters) after the
 * literal prefix. Deriving from every segment keeps distinct multi-segment
 * plan directories in distinct workspaces instead of merging on a basename.
 */
const VISIBLE_WORKSPACE_RE = /^bearing-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Derive the visible workspace directory name for a validated plan directory. */
export function planWorkspaceName(planDirectory: string): string {
  if (!planDirectoryValid(planDirectory)) {
    throw new Error(`Plan directory is not valid: ${planDirectory}`);
  }
  const suffix = planDirectory.slice("docs/plans/".length).split("/").join("-");
  // The visible workspace grammar allows at most 64 characters after the
  // "bearing-" prefix; joined multi-segment plans can exceed it. Rejecting
  // deterministically beats truncating, which could collide two distinct
  // plan directories onto one workspace.
  if (suffix.length > 64) {
    throw new Error(`Plan directory derives an over-long workspace name: ${planDirectory}`);
  }
  return `${VISIBLE_WORKSPACE_PREFIX}${suffix}`;
}

/** Absolute repository-root path of the visible workspace for a validated plan directory. */
export function planWorkspacePath(repositoryRoot: string, planDirectory: string): string {
  return join(repositoryRoot, planWorkspaceName(planDirectory));
}

/** True when name matches the reserved visible per-plan workspace namespace. */
export function isVisibleWorkspaceName(name: string): boolean {
  return VISIBLE_WORKSPACE_RE.test(name);
}

/**
 * Enumerate existing visible per-plan workspaces at the repository root.
 * Only real non-symlink directories whose realpath is the joined path itself
 * are reported; anything else is treated as an attacker placeholder, never as
 * a Bearing workspace.
 */
export async function visibleWorkspaces(repositoryRoot: string): Promise<string[]> {
  const names: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(repositoryRoot);
  } catch (error) {
    // Only an absent root reads as an empty workspace. Any other failure (e.g. EACCES) must
    // surface: swallowing it makes load() return a blank run, and a later legacy write then
    // creates a permanent run_location_conflict.
    if (isMissing(error)) return names;
    throw error;
  }
  for (const name of entries) {
    if (!isVisibleWorkspaceName(name)) continue;
    const path = join(repositoryRoot, name);
    try {
      const st = await lstat(path);
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      const real = await realpath(path);
      if (real !== path) continue;
      names.push(name);
    } catch {
      continue;
    }
  }
  return names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** POSIX-form repository-relative workspace path for disclosure, or undefined when invalid. */
export function workspaceRelativePath(repositoryRoot: string, workspacePath: string): string | undefined {
  if (!workspacePath.startsWith(repositoryRoot)) return undefined;
  const rest = workspacePath.slice(repositoryRoot.length).replace(/^[\\/]+/, "");
  if (!rest || rest.includes("\\") || posix.normalize(rest) !== rest) return undefined;
  return rest;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}
