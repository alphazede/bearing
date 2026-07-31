import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readdir, realpath, rename, stat, unlink, writeFile, } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { BUILTIN_ROUTES } from "../adapters/adapters.js";
import { resolveExecutable } from "./executable-path.js";
import { assessRepositorySafety } from "./safety.js";
const WORKSPACE_SCHEMA_VERSION = 1;
const BEARING_DIR = ".bearing";
const WORKSPACE_FILE = "workspace.json";
const TEMP_PREFIX = ".bearing.tmp-";
const OWNER_FILE = "owner.json";
const OWNER_TEMP_PREFIX = ".owner.tmp-";
const BEARING_IGNORE_LINES = [".bearing", ".bearing/", "/.bearing", "/.bearing/"];
export class RepositoryBootstrap {
    async choose(inputPath, opts) {
        const validated = await this.validateRepositoryPath(inputPath);
        if (!validated.ok)
            return validated;
        const repositoryPath = validated.repositoryPath;
        const isGitRoot = await lstat(join(repositoryPath, ".git"))
            .then((marker) => marker.isDirectory() || marker.isFile())
            .catch(() => false);
        const containingGitRoot = isGitRoot ? undefined : await findContainingGitRoot(repositoryPath);
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
        const bearingPath = join(repositoryPath, BEARING_DIR);
        const existing = await this.validateExistingBearing(bearingPath, repositoryPath);
        if (!safety.ok) {
            if (existing !== "missing" && existing.ok && existing.status === "resumed") {
                return this.withOwner(existing);
            }
            return { ok: false, reason: "repository_not_git" };
        }
        if (existing !== "missing")
            return existing.ok ? this.withOwner(existing) : existing;
        const interrupted = await this.hasInterruptedInitialization(repositoryPath);
        if (interrupted)
            return { ok: false, reason: "interrupted_initialization" };
        const initialized = await this.initialize(repositoryPath, bearingPath, await gitignoreState(repositoryPath, isGitRoot));
        return initialized.ok ? this.withOwner(initialized) : initialized;
    }
    async rememberOwnerName(repositoryPath, input) {
        const name = normalizeOwnerName(input);
        if (!name)
            return undefined;
        const bearingPath = join(repositoryPath, BEARING_DIR);
        const ownerPath = join(bearingPath, OWNER_FILE);
        const temporaryPath = join(bearingPath, `${OWNER_TEMP_PREFIX}${process.pid}-${randomBytes(8).toString("hex")}`);
        try {
            const directory = await lstat(bearingPath);
            if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(bearingPath) !== bearingPath)
                return undefined;
            await writeFile(temporaryPath, `${JSON.stringify({ name }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
            await syncPath(temporaryPath);
            await rename(temporaryPath, ownerPath);
            await syncPath(bearingPath);
            return name;
        }
        catch {
            return undefined;
        }
        finally {
            await unlink(temporaryPath).catch(() => { });
        }
    }
    async withOwner(result) {
        const ownerName = await readOwnerName(join(result.repositoryPath, BEARING_DIR, OWNER_FILE));
        return ownerName ? { ...result, ownerName } : result;
    }
    async validateRepositoryPath(inputPath) {
        if (!isAbsolute(inputPath))
            return { ok: false, reason: "path_not_absolute" };
        let repositoryPath;
        try {
            repositoryPath = await realpath(inputPath);
            const s = await stat(repositoryPath);
            if (!s.isDirectory())
                return { ok: false, reason: "repository_not_directory" };
        }
        catch {
            return { ok: false, reason: "repository_unavailable" };
        }
        try {
            await access(repositoryPath, constants.R_OK | constants.X_OK);
        }
        catch {
            return { ok: false, reason: "repository_unavailable" };
        }
        try {
            await access(repositoryPath, constants.W_OK | constants.X_OK);
        }
        catch {
            return { ok: false, reason: "repository_not_writable" };
        }
        return { ok: true, repositoryPath };
    }
    async validateExistingBearing(bearingPath, repositoryPath) {
        let s;
        try {
            s = await lstat(bearingPath);
        }
        catch (err) {
            if (isNodeError(err, "ENOENT"))
                return "missing";
            return { ok: false, reason: "repository_unavailable" };
        }
        if (s.isSymbolicLink())
            return { ok: false, reason: "bearing_symlink" };
        if (!s.isDirectory())
            return { ok: false, reason: "bearing_not_directory" };
        return this.validateManifest(bearingPath, repositoryPath);
    }
    async validateManifest(bearingPath, repositoryPath) {
        const entries = await readdir(bearingPath);
        if (!entries.includes(WORKSPACE_FILE)) {
            return { ok: false, reason: "manifest_missing" };
        }
        let parsed;
        const manifestPath = join(bearingPath, WORKSPACE_FILE);
        const manifestBody = await readRegularFileNoFollow(manifestPath);
        if (!manifestBody.ok)
            return { ok: false, reason: manifestBody.reason };
        try {
            parsed = JSON.parse(manifestBody.body);
        }
        catch {
            return { ok: false, reason: "manifest_malformed" };
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            return { ok: false, reason: "manifest_malformed" };
        }
        const manifest = parsed;
        if (typeof manifest.schemaVersion !== "number") {
            return { ok: false, reason: "manifest_malformed" };
        }
        if (manifest.schemaVersion > WORKSPACE_SCHEMA_VERSION) {
            return { ok: false, reason: "manifest_future_schema" };
        }
        if (manifest.schemaVersion !== WORKSPACE_SCHEMA_VERSION ||
            typeof manifest.repositoryPath !== "string") {
            return { ok: false, reason: "manifest_malformed" };
        }
        if (manifest.repositoryPath !== repositoryPath) {
            return { ok: false, reason: "manifest_repository_mismatch" };
        }
        return { ok: true, status: "resumed", repositoryPath };
    }
    async hasInterruptedInitialization(repositoryPath) {
        const entries = await readdir(repositoryPath);
        return entries.some((entry) => entry.startsWith(TEMP_PREFIX));
    }
    async initialize(repositoryPath, bearingPath, gitignore) {
        const tmpPath = join(repositoryPath, `${TEMP_PREFIX}${process.pid}-${Date.now()}-${randomBytes(8).toString("hex")}`);
        const manifest = {
            schemaVersion: WORKSPACE_SCHEMA_VERSION,
            repositoryPath,
        };
        try {
            await mkdir(tmpPath, { mode: 0o700 });
            await writeFile(join(tmpPath, WORKSPACE_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
            await syncPath(join(tmpPath, WORKSPACE_FILE));
            await syncPath(tmpPath);
            await rename(tmpPath, bearingPath);
            await syncPath(repositoryPath);
            return { ok: true, status: "initialized", repositoryPath, gitignoreMissing: gitignore.missing, gitignoreAbsent: gitignore.absent };
        }
        catch (err) {
            if (isNodeError(err, "EEXIST") ||
                isNodeError(err, "ENOTEMPTY") ||
                isNodeError(err, "ENOTDIR") ||
                isNodeError(err, "EISDIR")) {
                const winner = await this.validateExistingBearing(bearingPath, repositoryPath);
                if (winner !== "missing")
                    return winner;
            }
            return { ok: false, reason: "initialize_failed" };
        }
    }
}
async function findContainingGitRoot(candidate) {
    let current = dirname(candidate);
    while (true) {
        const marker = await lstat(join(current, ".git")).catch(() => undefined);
        if (marker?.isFile())
            return current;
        if (marker?.isDirectory()) {
            const head = await lstat(join(current, ".git", "HEAD")).catch(() => undefined);
            if (head?.isFile())
                return current;
        }
        const parent = dirname(current);
        if (parent === current)
            return undefined;
        current = parent;
    }
}
function knownAgentExecutableRealpaths() {
    return [...new Set(BUILTIN_ROUTES.flatMap(({ executable }) => resolveExecutable(executable) ?? []))];
}
/** Recognizes every literal `.bearing` ignore spelling Git treats as covering the directory. */
export function ignoresBearingDirectory(gitignoreBody) {
    return gitignoreBody
        .split(/\r?\n/)
        .some((line) => BEARING_IGNORE_LINES.includes(line.trim()));
}
/**
 * Distinguishes "a .gitignore exists but does not ignore .bearing/" from "there is
 * no .gitignore at all". Only the first case can be repaired by the consent
 * endpoint, which appends to an existing regular file and never creates one, so
 * only the first sets `gitignoreMissing`. Reporting the absent case as missing
 * would offer the owner an add action that always fails.
 */
async function gitignoreState(repositoryPath, isGitRoot) {
    if (!isGitRoot)
        return { missing: false, absent: false };
    const gitignore = await readRegularFileNoFollow(join(repositoryPath, ".gitignore"));
    if (!gitignore.ok)
        return { missing: false, absent: true };
    return { missing: !ignoresBearingDirectory(gitignore.body), absent: false };
}
function normalizeOwnerName(value) {
    const name = value.trim();
    return name.length > 0 && name.length <= 80 && !/[\u0000-\u001f\u007f]/.test(name) ? name : undefined;
}
async function readOwnerName(path) {
    const result = await readRegularFileNoFollow(path);
    if (!result.ok)
        return undefined;
    try {
        const parsed = JSON.parse(result.body);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || !("name" in parsed) || typeof parsed.name !== "string")
            return undefined;
        const normalized = normalizeOwnerName(parsed.name);
        return normalized === parsed.name ? normalized : undefined;
    }
    catch {
        return undefined;
    }
}
async function readRegularFileNoFollow(path) {
    let fh = null;
    try {
        fh = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const opened = await fh.stat();
        const linked = await lstat(path);
        if (!opened.isFile() || linked.isSymbolicLink() || !linked.isFile() || opened.dev !== linked.dev || opened.ino !== linked.ino)
            return { ok: false, reason: "manifest_malformed" };
        return { ok: true, body: await fh.readFile("utf8") };
    }
    catch (err) {
        return {
            ok: false,
            reason: isNodeError(err, "ENOENT") ? "manifest_missing" : "manifest_malformed",
        };
    }
    finally {
        await fh?.close();
    }
}
async function syncPath(path) {
    let fh = null;
    try {
        fh = await open(path, constants.O_RDONLY);
        await fh.sync();
    }
    catch (err) {
        if (!isIgnorableSyncError(err))
            throw err;
    }
    finally {
        await fh?.close();
    }
}
function isIgnorableSyncError(err) {
    return (isNodeError(err, "EINVAL") ||
        isNodeError(err, "ENOTSUP") ||
        isNodeError(err, "EISDIR") ||
        isNodeError(err, "EPERM"));
}
function isNodeError(err, code) {
    return typeof err === "object" && err !== null && err.code === code;
}
