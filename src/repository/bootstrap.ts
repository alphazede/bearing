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
import { isAbsolute, join } from "node:path";

const WORKSPACE_SCHEMA_VERSION = 1;
const BEARING_DIR = ".bearing";
const WORKSPACE_FILE = "workspace.json";
const TEMP_PREFIX = ".bearing.tmp-";
const OWNER_FILE = "owner.json";
const OWNER_TEMP_PREFIX = ".owner.tmp-";

export type BootstrapResult =
  | { ok: true; status: "initialized" | "resumed"; repositoryPath: string; ownerName?: string }
  | { ok: false; reason: BootstrapFailure };

export type BootstrapFailure =
  | "path_not_absolute"
  | "repository_unavailable"
  | "repository_not_directory"
  | "repository_not_writable"
  | "bearing_symlink"
  | "bearing_not_directory"
  | "manifest_missing"
  | "manifest_malformed"
  | "manifest_future_schema"
  | "manifest_repository_mismatch"
  | "interrupted_initialization"
  | "initialize_failed";

type RepositoryPathResult =
  | { ok: true; repositoryPath: string }
  | { ok: false; reason: BootstrapFailure };

interface WorkspaceManifest {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  repositoryPath: string;
}

export class RepositoryBootstrap {
  async choose(inputPath: string): Promise<BootstrapResult> {
    const validated = await this.validateRepositoryPath(inputPath);
    if (!validated.ok) return validated;

    const repositoryPath = validated.repositoryPath;
    const bearingPath = join(repositoryPath, BEARING_DIR);
    const existing = await this.validateExistingBearing(bearingPath, repositoryPath);
    if (existing !== "missing") return existing.ok ? this.withOwner(existing) : existing;

    const interrupted = await this.hasInterruptedInitialization(repositoryPath);
    if (interrupted) return { ok: false, reason: "interrupted_initialization" };

    const initialized = await this.initialize(repositoryPath, bearingPath);
    return initialized.ok ? this.withOwner(initialized) : initialized;
  }

  async rememberOwnerName(repositoryPath: string, input: string): Promise<string | undefined> {
    const name = normalizeOwnerName(input);
    if (!name) return undefined;
    const bearingPath = join(repositoryPath, BEARING_DIR);
    const ownerPath = join(bearingPath, OWNER_FILE);
    const temporaryPath = join(bearingPath, `${OWNER_TEMP_PREFIX}${process.pid}-${randomBytes(8).toString("hex")}`);
    try {
      const directory = await lstat(bearingPath);
      if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(bearingPath) !== bearingPath) return undefined;
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
      return { ok: true, status: "initialized", repositoryPath };
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
