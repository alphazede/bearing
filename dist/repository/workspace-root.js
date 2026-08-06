import { lstat, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
export class WorkspaceRootError extends Error {
    code = "workspace_root_changed";
    constructor(message, options) {
        super(message, options);
        this.name = "WorkspaceRootError";
    }
}
export function isWorkspaceRootError(error) {
    return (error instanceof WorkspaceRootError ||
        (typeof error === "object" &&
            error !== null &&
            error.code === "workspace_root_changed"));
}
/**
 * Pins canonical repository path, canonical .bearing path, and device/inode identity of .bearing.
 */
export async function pinWorkspaceRoot(repositoryPath) {
    let canonicalRepo;
    try {
        canonicalRepo = await realpath(repositoryPath);
    }
    catch (err) {
        throw new WorkspaceRootError(`Repository path is unavailable: ${repositoryPath}`, { cause: err });
    }
    const bearingPath = join(canonicalRepo, ".bearing");
    let st;
    try {
        st = await lstat(bearingPath);
    }
    catch (err) {
        if (typeof err === "object" && err !== null && err.code === "ENOENT") {
            throw err;
        }
        throw new WorkspaceRootError(`Workspace directory unavailable at ${bearingPath}`, { cause: err });
    }
    if (st.isSymbolicLink()) {
        throw new WorkspaceRootError(`Workspace directory at ${bearingPath} is a symbolic link`);
    }
    if (!st.isDirectory()) {
        throw new WorkspaceRootError(`Workspace directory at ${bearingPath} is not a directory`);
    }
    let realBearing;
    try {
        realBearing = await realpath(bearingPath);
    }
    catch (err) {
        throw new WorkspaceRootError(`Failed to resolve realpath of ${bearingPath}`, { cause: err });
    }
    if (realBearing !== bearingPath) {
        throw new WorkspaceRootError(`Workspace realpath mismatch: expected ${bearingPath}, got ${realBearing}`);
    }
    return {
        repositoryPath: canonicalRepo,
        bearingPath,
        dev: st.dev,
        ino: st.ino,
    };
}
/**
 * Asserts that .bearing remains a non-symlink directory with equal realpath and dev/ino identity.
 */
export async function assertWorkspaceRoot(pinned) {
    let st;
    try {
        st = await lstat(pinned.bearingPath);
    }
    catch (err) {
        throw new WorkspaceRootError(`Workspace directory unavailable at ${pinned.bearingPath}`, { cause: err });
    }
    if (st.isSymbolicLink()) {
        throw new WorkspaceRootError(`Workspace directory at ${pinned.bearingPath} is a symbolic link`);
    }
    if (!st.isDirectory()) {
        throw new WorkspaceRootError(`Workspace directory at ${pinned.bearingPath} is not a directory`);
    }
    if (st.dev !== pinned.dev || st.ino !== pinned.ino) {
        throw new WorkspaceRootError(`Workspace directory identity mismatch at ${pinned.bearingPath}`);
    }
    let realBearing;
    try {
        realBearing = await realpath(pinned.bearingPath);
    }
    catch (err) {
        throw new WorkspaceRootError(`Failed to resolve realpath of ${pinned.bearingPath}`, { cause: err });
    }
    if (realBearing !== pinned.bearingPath) {
        throw new WorkspaceRootError(`Workspace realpath mismatch: expected ${pinned.bearingPath}, got ${realBearing}`);
    }
}
/**
 * Validates that targetPath (and its realpath) remains contained within pinned.bearingPath.
 */
export async function assertContained(pinned, targetPath) {
    await assertWorkspaceRoot(pinned);
    let realTarget;
    try {
        realTarget = await realpath(targetPath);
    }
    catch {
        // If targetPath does not exist yet, check its parent recursively up to bearingPath
        let parent = resolve(targetPath, "..");
        let parentReal;
        while (parent !== resolve(parent, "..")) {
            try {
                parentReal = await realpath(parent);
                break;
            }
            catch {
                parent = resolve(parent, "..");
            }
        }
        if (parentReal !== undefined) {
            const relParent = relative(pinned.bearingPath, parentReal);
            if (relParent.startsWith("..") || isAbsolute(relParent)) {
                throw new WorkspaceRootError(`Target parent ${parent} (realpath ${parentReal}) escapes workspace ${pinned.bearingPath}`);
            }
        }
        return targetPath;
    }
    const rel = relative(pinned.bearingPath, realTarget);
    if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new WorkspaceRootError(`Target path ${targetPath} (realpath ${realTarget}) escapes workspace ${pinned.bearingPath}`);
    }
    return realTarget;
}
/**
 * Narrowly safe rollback: removes only firstCreated if it is proven to be a directory (not symlink)
 * and its realpath is strictly contained within pinned.bearingPath.
 */
export async function safeRollbackCreatedDirectory(pinned, firstCreated) {
    if (!firstCreated || !pinned)
        return;
    try {
        const st = await lstat(firstCreated);
        if (st.isSymbolicLink() || !st.isDirectory())
            return;
        const realCreated = await realpath(firstCreated);
        const rel = relative(pinned.bearingPath, realCreated);
        if (rel.startsWith("..") || isAbsolute(rel)) {
            // External target: preserve it!
            return;
        }
        await rm(firstCreated, { recursive: true, force: true });
    }
    catch {
        // Ignore cleanup failures during emergency rollback
    }
}
