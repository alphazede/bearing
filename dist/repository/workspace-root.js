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
const LEGACY_WORKSPACE_NAME = ".bearing";
/**
 * Pins the canonical repository path, one repository-root workspace directory
 * (the hidden `.bearing` or a visible `bearing-<plan>` per-plan workspace), and
 * the workspace's device/inode identity.
 */
export async function pinWorkspace(repositoryPath, workspaceName) {
    if (workspaceName === "" || workspaceName === "." || workspaceName === ".." ||
        workspaceName.includes("/") || workspaceName.includes("\\")) {
        throw new WorkspaceRootError(`Invalid workspace name: ${workspaceName}`);
    }
    let canonicalRepo;
    try {
        canonicalRepo = await realpath(repositoryPath);
    }
    catch (err) {
        throw new WorkspaceRootError(`Repository path is unavailable: ${repositoryPath}`, { cause: err });
    }
    const workspacePath = join(canonicalRepo, workspaceName);
    let st;
    try {
        st = await lstat(workspacePath);
    }
    catch (err) {
        if (typeof err === "object" && err !== null && err.code === "ENOENT") {
            throw err;
        }
        throw new WorkspaceRootError(`Workspace directory unavailable at ${workspacePath}`, { cause: err });
    }
    if (st.isSymbolicLink()) {
        throw new WorkspaceRootError(`Workspace directory at ${workspacePath} is a symbolic link`);
    }
    if (!st.isDirectory()) {
        throw new WorkspaceRootError(`Workspace directory at ${workspacePath} is not a directory`);
    }
    let realWorkspace;
    try {
        realWorkspace = await realpath(workspacePath);
    }
    catch (err) {
        throw new WorkspaceRootError(`Failed to resolve realpath of ${workspacePath}`, { cause: err });
    }
    if (realWorkspace !== workspacePath) {
        throw new WorkspaceRootError(`Workspace realpath mismatch: expected ${workspacePath}, got ${realWorkspace}`);
    }
    return {
        repositoryPath: canonicalRepo,
        workspacePath,
        dev: st.dev,
        ino: st.ino,
    };
}
/**
 * Pins canonical repository path, canonical .bearing path, and device/inode identity of .bearing.
 */
export async function pinWorkspaceRoot(repositoryPath) {
    return pinWorkspace(repositoryPath, LEGACY_WORKSPACE_NAME);
}
/**
 * Asserts that the pinned workspace remains a non-symlink directory with equal realpath and dev/ino identity.
 */
async function assertWorkspace(pinned) {
    let st;
    try {
        st = await lstat(pinned.workspacePath);
    }
    catch (err) {
        throw new WorkspaceRootError(`Workspace directory unavailable at ${pinned.workspacePath}`, { cause: err });
    }
    if (st.isSymbolicLink()) {
        throw new WorkspaceRootError(`Workspace directory at ${pinned.workspacePath} is a symbolic link`);
    }
    if (!st.isDirectory()) {
        throw new WorkspaceRootError(`Workspace directory at ${pinned.workspacePath} is not a directory`);
    }
    if (st.dev !== pinned.dev || st.ino !== pinned.ino) {
        throw new WorkspaceRootError(`Workspace directory identity mismatch at ${pinned.workspacePath}`);
    }
    let realWorkspace;
    try {
        realWorkspace = await realpath(pinned.workspacePath);
    }
    catch (err) {
        throw new WorkspaceRootError(`Failed to resolve realpath of ${pinned.workspacePath}`, { cause: err });
    }
    if (realWorkspace !== pinned.workspacePath) {
        throw new WorkspaceRootError(`Workspace realpath mismatch: expected ${pinned.workspacePath}, got ${realWorkspace}`);
    }
}
/**
 * Asserts that .bearing remains a non-symlink directory with equal realpath and dev/ino identity.
 */
export async function assertWorkspaceRoot(pinned) {
    return assertWorkspace(pinned);
}
/**
 * Validates that targetPath (and its realpath) remains contained within the pinned workspace.
 */
export async function assertContained(pinned, targetPath) {
    await assertWorkspace(pinned);
    let realTarget;
    try {
        realTarget = await realpath(targetPath);
    }
    catch {
        // If targetPath does not exist yet, check its parent recursively up to the workspace
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
            const relParent = relative(pinned.workspacePath, parentReal);
            if (relParent.startsWith("..") || isAbsolute(relParent)) {
                throw new WorkspaceRootError(`Target parent ${parent} (realpath ${parentReal}) escapes workspace ${pinned.workspacePath}`);
            }
        }
        return targetPath;
    }
    const rel = relative(pinned.workspacePath, realTarget);
    if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new WorkspaceRootError(`Target path ${targetPath} (realpath ${realTarget}) escapes workspace ${pinned.workspacePath}`);
    }
    return realTarget;
}
/**
 * Narrowly safe rollback: removes only firstCreated if it is proven to be a directory (not symlink)
 * and its realpath is strictly contained within the pinned workspace.
 */
export async function safeRollbackCreatedDirectory(pinned, firstCreated) {
    if (!firstCreated || !pinned)
        return;
    try {
        const st = await lstat(firstCreated);
        if (st.isSymbolicLink() || !st.isDirectory())
            return;
        const realCreated = await realpath(firstCreated);
        const rel = relative(pinned.workspacePath, realCreated);
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
