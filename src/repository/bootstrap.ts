import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { BUILTIN_ROUTES } from "../adapters/adapters.js";
import { resolveExecutable } from "./executable-path.js";
import { assessRepositorySafety } from "./safety.js";
import { isVisibleWorkspaceName } from "./workspace-location.js";
import { assertContained, assertWorkspaceRoot, isWorkspaceRootError, pinWorkspaceRoot } from "./workspace-root.js";

const WORKSPACE_SCHEMA_VERSION = 1;
const BEARING_DIR = ".bearing";
const WORKSPACE_FILE = "workspace.json";
const TEMP_PREFIX = ".bearing.tmp-";
const OWNER_FILE = "owner.json";
const OWNER_TEMP_PREFIX = ".owner.tmp-";
const BEARING_IGNORE_LINES: readonly string[] = [".bearing", ".bearing/", "/.bearing", "/.bearing/"];
const VISIBLE_WORKSPACE_IGNORE_LINES: readonly string[] = ["bearing-*", "bearing-*/", "/bearing-*", "/bearing-*/"];

export type BootstrapResult =
  | { ok: true; status: "initialized"; repositoryPath: string; gitignoreMissing: boolean; gitignoreAbsent: boolean; ownerName?: string }
  | { ok: true; status: "resumed"; repositoryPath: string; ownerName?: string }
  | { ok: false; reason: BootstrapFailure; containingRepositoryPath?: string };

type BootstrapFailure =
  | "path_not_absolute"
  | "repository_unavailable"
  | "repository_not_directory"
  | "repository_not_writable"
  | "repository_not_git"
  | "repository_nested_in_git"
  | "repository_contains_agent"
  | "bearing_symlink"
  | "bearing_not_directory"
  | "manifest_missing"
  | "manifest_malformed"
  | "manifest_future_schema"
  | "manifest_repository_mismatch"
  | "interrupted_initialization"
  | "initialize_failed"
  | "visible_workspace_placeholder";

type RepositoryPathResult =
  | { ok: true; repositoryPath: string }
  | { ok: false; reason: BootstrapFailure };

interface WorkspaceManifest {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  repositoryPath: string;
}

export class RepositoryBootstrap {
  async choose(
    inputPath: string,
    opts?: {
      ownerConfirmedNonGit?: boolean;
      agentExecutableRealpaths?: readonly string[];
      legacyWorkspaceProof?: (repositoryPath: string) => Promise<boolean>;
    },
  ): Promise<BootstrapResult> {
    const validated = await this.validateRepositoryPath(inputPath);
    if (!validated.ok) return validated;

    const repositoryPath = validated.repositoryPath;
    const markerPresent = await lstat(join(repositoryPath, ".git"))
      .then((marker) => marker.isDirectory() || marker.isFile())
      .catch(() => false);
    const gitTopLevel = await resolveGitTopLevel(repositoryPath);
    const resolvedGitRoot = gitTopLevel === repositoryPath;
    const containingGitRoot = resolvedGitRoot
      ? undefined
      : gitTopLevel ?? await findContainingGitRoot(repositoryPath);
    const isGitRoot = resolvedGitRoot ||
      (gitTopLevel === undefined && markerPresent && containingGitRoot === undefined);
    const safety = assessRepositorySafety({
      candidate: repositoryPath,
      isGitRoot,
      containingGitRoot,
      agentExecutableRealpaths: opts?.agentExecutableRealpaths ?? knownAgentExecutableRealpaths(),
      ownerConfirmedNonGit: opts?.ownerConfirmedNonGit === true,
    });
    if (!safety.ok && safety.code === "repository_contains_agent") {
      return { ok: false, reason: "repository_contains_agent" };
    }
    if (!safety.ok && safety.code === "repository_nested_in_git") {
      return { ok: false, reason: "repository_nested_in_git", containingRepositoryPath: containingGitRoot };
    }

    // A top-level directory that only looks like a visible per-plan workspace (no runs/) is an
    // owner-owned placeholder, not a Bearing workspace. Once Bearing ignores `bearing-*/` and
    // enumerates these names, it would be misreported as a plan workspace and could swallow a
    // future migration, so fail closed with a typed reason until the owner removes or renames it.
    const placeholder = await findVisibleWorkspacePlaceholder(repositoryPath);
    if (placeholder !== undefined) {
      return { ok: false, reason: "visible_workspace_placeholder" };
    }

    const bearingPath = join(repositoryPath, BEARING_DIR);
    let existing = await this.validateExistingBearing(bearingPath, repositoryPath);
    if (existing !== "missing" && !existing.ok && existing.reason === "manifest_missing" && opts?.legacyWorkspaceProof) {
      if (await opts.legacyWorkspaceProof(repositoryPath)) {
        existing = { ok: true, status: "resumed", repositoryPath };
      }
    }
    if (!safety.ok) {
      if (existing !== "missing" && existing.ok && existing.status === "resumed") {
        return this.withOwner(existing);
      }
      return { ok: false, reason: "repository_not_git" };
    }
    if (existing !== "missing") return existing.ok ? this.withOwner(existing) : existing;

    const interrupted = await this.hasInterruptedInitialization(repositoryPath);
    if (interrupted) return { ok: false, reason: "interrupted_initialization" };

    const initialized = await this.initialize(
      repositoryPath,
      bearingPath,
      await gitignoreState(repositoryPath, isGitRoot),
    );
    return initialized.ok ? this.withOwner(initialized) : initialized;
  }

  async rememberOwnerName(repositoryPath: string, input: string): Promise<string | undefined> {
    const name = normalizeOwnerName(input);
    if (!name) return undefined;
    const bearingPath = join(repositoryPath, BEARING_DIR);
    const ownerPath = join(bearingPath, OWNER_FILE);
    const temporaryPath = join(bearingPath, `${OWNER_TEMP_PREFIX}${process.pid}-${randomBytes(8).toString("hex")}`);
    try {
      const pinned = await pinWorkspaceRoot(repositoryPath);
      await assertContained(pinned, temporaryPath);
      await assertContained(pinned, ownerPath);
      await writeFile(temporaryPath, `${JSON.stringify({ name }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await syncPath(temporaryPath);
      await rename(temporaryPath, ownerPath);
      await syncPath(bearingPath);
      return name;
    } catch {
      return undefined;
    } finally {
      await unlink(temporaryPath).catch(() => {});
    }
  }

  private async withOwner(result: Extract<BootstrapResult, { ok: true }>): Promise<Extract<BootstrapResult, { ok: true }>> {
    const ownerName = await readOwnerName(join(result.repositoryPath, BEARING_DIR, OWNER_FILE));
    return ownerName ? { ...result, ownerName } : result;
  }

  private async validateRepositoryPath(
    inputPath: string,
  ): Promise<RepositoryPathResult> {
    if (!isAbsolute(inputPath)) return { ok: false, reason: "path_not_absolute" };

    let repositoryPath: string;
    try {
      repositoryPath = await realpath(inputPath);
      const s = await stat(repositoryPath);
      if (!s.isDirectory()) return { ok: false, reason: "repository_not_directory" };
    } catch {
      return { ok: false, reason: "repository_unavailable" };
    }

    try {
      await access(repositoryPath, constants.R_OK | constants.X_OK);
    } catch {
      return { ok: false, reason: "repository_unavailable" };
    }
    try {
      await access(repositoryPath, constants.W_OK | constants.X_OK);
    } catch {
      return { ok: false, reason: "repository_not_writable" };
    }
    return { ok: true, repositoryPath };
  }

  private async validateExistingBearing(
    bearingPath: string,
    repositoryPath: string,
  ): Promise<"missing" | BootstrapResult> {
    let s: Awaited<ReturnType<typeof lstat>>;
    try {
      s = await lstat(bearingPath);
    } catch (err) {
      if (isNodeError(err, "ENOENT")) return "missing";
      return { ok: false, reason: "repository_unavailable" };
    }
    if (s.isSymbolicLink()) return { ok: false, reason: "bearing_symlink" };
    if (!s.isDirectory()) return { ok: false, reason: "bearing_not_directory" };
    try {
      const pinned = await pinWorkspaceRoot(repositoryPath);
      await assertWorkspaceRoot(pinned);
    } catch (err) {
      if (isWorkspaceRootError(err)) return { ok: false, reason: "bearing_symlink" };
      return { ok: false, reason: "repository_unavailable" };
    }
    return this.validateManifest(bearingPath, repositoryPath);
  }

  private async validateManifest(
    bearingPath: string,
    repositoryPath: string,
  ): Promise<BootstrapResult> {
    const entries = await readdir(bearingPath);
    if (!entries.includes(WORKSPACE_FILE)) {
      return { ok: false, reason: "manifest_missing" };
    }

    let parsed: unknown;
    const manifestPath = join(bearingPath, WORKSPACE_FILE);
    const manifestBody = await readRegularFileNoFollow(manifestPath);
    if (!manifestBody.ok) return { ok: false, reason: manifestBody.reason };
    try {
      parsed = JSON.parse(manifestBody.body);
    } catch {
      return { ok: false, reason: "manifest_malformed" };
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, reason: "manifest_malformed" };
    }
    const manifest = parsed as Partial<Record<keyof WorkspaceManifest, unknown>>;
    if (typeof manifest.schemaVersion !== "number") {
      return { ok: false, reason: "manifest_malformed" };
    }
    if (manifest.schemaVersion > WORKSPACE_SCHEMA_VERSION) {
      return { ok: false, reason: "manifest_future_schema" };
    }
    if (
      manifest.schemaVersion !== WORKSPACE_SCHEMA_VERSION ||
      typeof manifest.repositoryPath !== "string"
    ) {
      return { ok: false, reason: "manifest_malformed" };
    }
    if (manifest.repositoryPath !== repositoryPath) {
      return { ok: false, reason: "manifest_repository_mismatch" };
    }
    return { ok: true, status: "resumed", repositoryPath };
  }

  private async hasInterruptedInitialization(repositoryPath: string): Promise<boolean> {
    const entries = await readdir(repositoryPath);
    return entries.some((entry) => entry.startsWith(TEMP_PREFIX));
  }

  private async initialize(
    repositoryPath: string,
    bearingPath: string,
    gitignore: { missing: boolean; absent: boolean },
  ): Promise<BootstrapResult> {
    const tmpPath = join(
      repositoryPath,
      `${TEMP_PREFIX}${process.pid}-${Date.now()}-${randomBytes(8).toString("hex")}`,
    );
    const manifest: WorkspaceManifest = {
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      repositoryPath,
    };

    try {
      await mkdir(tmpPath, { mode: 0o700 });
      await writeFile(
        join(tmpPath, WORKSPACE_FILE),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { mode: 0o600 },
      );
      await syncPath(join(tmpPath, WORKSPACE_FILE));
      await syncPath(tmpPath);
      await rename(tmpPath, bearingPath);
      await syncPath(repositoryPath);
      await pinWorkspaceRoot(repositoryPath);
      return { ok: true, status: "initialized", repositoryPath, gitignoreMissing: gitignore.missing, gitignoreAbsent: gitignore.absent };
    } catch (err) {
      if (
        isNodeError(err, "EEXIST") ||
        isNodeError(err, "ENOTEMPTY") ||
        isNodeError(err, "ENOTDIR") ||
        isNodeError(err, "EISDIR")
      ) {
        const winner = await this.validateExistingBearing(bearingPath, repositoryPath);
        if (winner !== "missing") return winner;
      }
      return { ok: false, reason: "initialize_failed" };
    }
  }
}

/**
 * The first top-level directory that matches the visible per-plan workspace
 * namespace but holds no run audit trail (`runs/`), or undefined when none.
 * Only real non-symlink directories count: a symlink or file is never a
 * workspace and does not trigger the placeholder blocker.
 */
async function findVisibleWorkspacePlaceholder(repositoryPath: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(repositoryPath);
  } catch (error) {
    // The path was validated readable moments ago; an ENOENT race just means
    // there is nothing to scan, anything else is a real failure.
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
  for (const name of entries) {
    if (!isVisibleWorkspaceName(name)) continue;
    const path = join(repositoryPath, name);
    try {
      const entry = await lstat(path);
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const hasRuns = await lstat(join(path, "runs"))
        .then((runs) => runs.isDirectory())
        .catch(() => false);
      if (!hasRuns) return name;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function findContainingGitRoot(candidate: string): Promise<string | undefined> {
  let current = dirname(candidate);
  while (true) {
    const marker = await lstat(join(current, ".git")).catch(() => undefined);
    if (marker?.isFile()) return current;
    if (marker?.isDirectory()) {
      const head = await lstat(join(current, ".git", "HEAD")).catch(() => undefined);
      if (head?.isFile()) return current;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function resolveGitTopLevel(candidate: string): Promise<string | undefined> {
  const repositoryEnvironment = new Set([
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CEILING_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_WORK_TREE",
  ]);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !repositoryEnvironment.has(name) && !name.startsWith("GIT_CONFIG_")));
  return new Promise((resolveTopLevel) => {
    execFile("git", ["-c", "core.fsmonitor=false", "-C", candidate, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      env: {
        ...environment,
        GIT_CEILING_DIRECTORIES: "",
        GIT_DISCOVERY_ACROSS_FILESYSTEM: "1",
        LANG: "C",
        LC_ALL: "C",
      },
      maxBuffer: 16 * 1024,
      timeout: 5_000,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        resolveTopLevel(undefined);
        return;
      }
      const topLevel = stdout.trim();
      if (!isAbsolute(topLevel)) {
        resolveTopLevel(undefined);
        return;
      }
      realpath(topLevel).then(resolveTopLevel, () => resolveTopLevel(undefined));
    });
  });
}

function knownAgentExecutableRealpaths(): readonly string[] {
  return [...new Set(BUILTIN_ROUTES.flatMap(({ executable }) => resolveExecutable(executable) ?? []))];
}

/** Recognizes every literal `.bearing` ignore spelling Git treats as covering the directory. */
export function ignoresBearingDirectory(gitignoreBody: string): boolean {
  return gitignoreBody
    .split(/\r?\n/)
    .some((line) => BEARING_IGNORE_LINES.includes(line.trim()));
}

/** Recognizes every spelling that covers the visible `bearing-<plan>/` per-plan workspaces. */
export function ignoresBearingWorkspaces(gitignoreBody: string): boolean {
  return gitignoreBody
    .split(/\r?\n/)
    .some((line) => VISIBLE_WORKSPACE_IGNORE_LINES.includes(line.trim()));
}

/**
 * True only when a .gitignore body covers BOTH the hidden `.bearing/` and every
 * visible `bearing-<plan>/` workspace. Bearing never reports the repository as
 * safe to commit while either audit-trail location could be tracked.
 */
export function gitignoreCoversBearingState(gitignoreBody: string): boolean {
  return ignoresBearingDirectory(gitignoreBody) && ignoresBearingWorkspaces(gitignoreBody);
}

/**
 * Distinguishes "a .gitignore exists but does not ignore Bearing's state" from
 * "there is no .gitignore at all". Only the first case can be repaired by the
 * consent endpoint, which appends to an existing regular file and never creates
 * one, so only the first sets `gitignoreMissing`. Reporting the absent case as
 * missing would offer the owner an add action that always fails.
 */
async function gitignoreState(repositoryPath: string, isGitRoot: boolean): Promise<{ missing: boolean; absent: boolean }> {
  if (!isGitRoot) return { missing: false, absent: false };
  const gitignore = await readRegularFileNoFollow(join(repositoryPath, ".gitignore"));
  if (!gitignore.ok) return { missing: false, absent: true };
  return { missing: !gitignoreCoversBearingState(gitignore.body), absent: false };
}

function normalizeOwnerName(value: string): string | undefined {
  const name = value.trim();
  return name.length > 0 && name.length <= 80 && !/[\u0000-\u001f\u007f]/.test(name) ? name : undefined;
}

async function readOwnerName(path: string): Promise<string | undefined> {
  const result = await readRegularFileNoFollow(path);
  if (!result.ok) return undefined;
  try {
    const parsed = JSON.parse(result.body) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || !("name" in parsed) || typeof parsed.name !== "string") return undefined;
    const normalized = normalizeOwnerName(parsed.name);
    return normalized === parsed.name ? normalized : undefined;
  } catch {
    return undefined;
  }
}

async function readRegularFileNoFollow(
  path: string,
): Promise<
  | { ok: true; body: string }
  | { ok: false; reason: "manifest_missing" | "manifest_malformed" }
> {
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await fh.stat();
    const linked = await lstat(path);
    if (!opened.isFile() || linked.isSymbolicLink() || !linked.isFile() || opened.dev !== linked.dev || opened.ino !== linked.ino) return { ok: false, reason: "manifest_malformed" };
    return { ok: true, body: await fh.readFile("utf8") };
  } catch (err) {
    return {
      ok: false,
      reason: isNodeError(err, "ENOENT") ? "manifest_missing" : "manifest_malformed",
    };
  } finally {
    await fh?.close();
  }
}

async function syncPath(path: string): Promise<void> {
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(path, constants.O_RDONLY);
    await fh.sync();
  } catch (err) {
    if (!isIgnorableSyncError(err)) throw err;
  } finally {
    await fh?.close();
  }
}

function isIgnorableSyncError(err: unknown): boolean {
  return (
    isNodeError(err, "EINVAL") ||
    isNodeError(err, "ENOTSUP") ||
    isNodeError(err, "EISDIR") ||
    isNodeError(err, "EPERM")
  );
}

function isNodeError(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
}
