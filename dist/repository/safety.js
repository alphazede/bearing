import { isAbsolute, relative } from "node:path";
export function assessRepositorySafety(input) {
    for (const entry of input.agentExecutableRealpaths) {
        const rel = relative(input.candidate, entry);
        const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
        if (inside) {
            return {
                ok: false,
                code: "repository_contains_agent",
                remedy: "Choose a project repository, not a directory that contains your agent tools such as your home directory.",
            };
        }
    }
    if (!input.isGitRoot && input.containingGitRoot) {
        return {
            ok: false,
            code: "repository_nested_in_git",
            remedy: `This directory is inside Git repository ${input.containingGitRoot}. Choose ${input.containingGitRoot} instead.`,
        };
    }
    if (!input.isGitRoot) {
        if (input.ownerConfirmedNonGit)
            return { ok: true, warnings: ["not_git_repository"] };
        return {
            ok: false,
            code: "not_git_repository",
            remedy: "This directory is not a Git repository. Bearing's execution focus-validation snapshots Git before every slice. Confirm to use it for planning-only, or choose a Git repository.",
        };
    }
    return { ok: true, warnings: [] };
}
