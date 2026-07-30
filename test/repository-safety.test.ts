import { describe, expect, it } from "vitest";
import { isAbsolute, relative } from "node:path";
import { assessRepositorySafety } from "../src/repository/safety.js";

const candidate = "/workspace/project";

function runnerGuardInside(root: string, entry: string): boolean {
  const rel = relative(root, entry);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

describe("assessRepositorySafety", () => {
  it("blocks when a known agent executable is inside the candidate", () => {
    expect(assessRepositorySafety({
      candidate,
      isGitRoot: false,
      agentExecutableRealpaths: [`${candidate}/.local/bin/codex`],
      ownerConfirmedNonGit: false,
    })).toEqual({
      ok: false,
      code: "repository_contains_agent",
      remedy: "Choose a project repository, not a directory that contains your agent tools such as your home directory.",
    });
  });

  it("allows when the known agent executable is outside the candidate", () => {
    expect(assessRepositorySafety({
      candidate,
      isGitRoot: true,
      agentExecutableRealpaths: ["/opt/agents/codex"],
      ownerConfirmedNonGit: false,
    })).toEqual({ ok: true, warnings: [] });
  });

  it("allows a non-Git directory only after owner confirmation and warns", () => {
    const input = {
      candidate,
      isGitRoot: false,
      agentExecutableRealpaths: [],
    } as const;
    expect(assessRepositorySafety({ ...input, ownerConfirmedNonGit: false })).toEqual({
      ok: false,
      code: "not_git_repository",
      remedy: "This directory is not a Git repository. Bearing's execution focus-validation snapshots Git before every slice. Confirm to use it for planning-only, or choose a Git repository.",
    });
    expect(assessRepositorySafety({ ...input, ownerConfirmedNonGit: true })).toEqual({
      ok: true,
      warnings: ["not_git_repository"],
    });
  });

  it("does not infer an agent from an unrelated bin path", () => {
    expect(runnerGuardInside(candidate, `${candidate}/bin/tool`)).toBe(true);
    expect(assessRepositorySafety({
      candidate,
      isGitRoot: true,
      agentExecutableRealpaths: ["/opt/agents/codex"],
      ownerConfirmedNonGit: false,
    })).toEqual({ ok: true, warnings: [] });
  });

  it("matches the process-runner containment predicate", () => {
    for (const [root, entry] of [
      [candidate, `${candidate}/.local/bin/codex`],
      [candidate, "/opt/agents/codex"],
      [candidate, candidate],
    ] as const) {
      const result = assessRepositorySafety({
        candidate: root,
        isGitRoot: true,
        agentExecutableRealpaths: [entry],
        ownerConfirmedNonGit: false,
      });
      expect(!result.ok && result.code === "repository_contains_agent").toBe(runnerGuardInside(root, entry));
    }
  });
});
