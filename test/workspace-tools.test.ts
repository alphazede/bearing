import { execFile } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandEnvelopeV1 } from "../src/contracts/run.js";
import {
  workspaceCompact,
  workspaceDoctor,
  workspacePrune,
  workspaceStatus,
  writeWorkspaceBusyLease,
  type WorkspaceToolsDeps,
} from "../src/repository/workspace-tools.js";
import {
  BearingStore,
  type CallerCleanlinessProof,
  type RetentionPlanEntry,
  type RetentionPolicy,
} from "../src/store/bearing-store.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    lstat: vi.fn(original.lstat),
    readFile: vi.fn(original.readFile),
  };
});

const roots: string[] = [];
const CLEANLINESS_PROOF = {
  noDirtyOrUnmergedLane: true,
  runNotBusy: true,
} as const;
const NOW = new Date("2026-07-25T12:00:00.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function repository(): Promise<{ base: string; root: string }> {
  const base = await mkdtemp(join(tmpdir(), "bearing-workspace-"));
  roots.push(base);
  const root = join(base, "repository");
  await mkdir(root);
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "bearing@example.invalid"]);
  await git(root, ["config", "user.name", "Bearing Test"]);
  await writeFile(join(root, ".gitignore"), ".bearing/\n");
  await writeFile(join(root, "tracked.txt"), "baseline\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "baseline"]);
  return { base, root };
}

function checkpoint(
  runId: string,
  expectedRevision: number,
  status: "running" | "complete",
): CommandEnvelopeV1 {
  return {
    schemaVersion: 1,
    commandId: `checkpoint-${runId}`,
    runId,
    expectedRevision,
    session: { sessionId: "session-bearing", actor: "bearing" },
    correlationId: `checkpoint-${runId}`,
    type: "recordJourneyCheckpoint",
    payload: {
      stage: "review",
      status,
      artifacts: ["docs/plans/run/review.html"],
      lastResultJson: JSON.stringify({
        status: "action",
        summary: "Review complete.",
        artifacts: ["docs/plans/run/review.html"],
        tokens: 10,
      }),
    },
  };
}

async function seedRun(
  root: string,
  runId: string,
  status: "running" | "complete",
): Promise<BearingStore> {
  const store = new BearingStore(root);
  const created = await store.apply({
    schemaVersion: 1,
    commandId: `create-${runId}`,
    runId,
    expectedRevision: 0,
    session: { sessionId: "session-owner", actor: "owner" },
    correlationId: `create-${runId}`,
    type: "createWorkRequest",
    payload: { title: runId, goal: `Goal for ${runId}` },
  });
  if (!created.ok) throw new Error(created.reason);
  const recorded = await store.apply(checkpoint(runId, created.state.revision, status));
  if (!recorded.ok) throw new Error(recorded.reason);
  return store;
}

function ledger(root: string, runId: string): string {
  return join(root, ".bearing", "runs", runId, "events.jsonl");
}

function snapshot(root: string, runId: string): string {
  return join(root, ".bearing", "runs", runId, "snapshot.json");
}

function accessDenied(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`EACCES: permission denied, open '${path}'`), {
    code: "EACCES",
    errno: -13,
    syscall: "open",
    path,
  });
}

async function withReadFileError<T>(
  targetPath: string,
  error: NodeJS.ErrnoException,
  operation: () => Promise<T>,
): Promise<T> {
  const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const injectedReadFile = (...args: unknown[]) => {
    if (String(args[0]) === targetPath) return Promise.reject(error);
    return Reflect.apply(original.readFile, undefined, args);
  };
  return await vi.mocked(readFile).withImplementation(
    injectedReadFile as unknown as typeof readFile,
    operation,
  ) as unknown as T;
}

async function withLstatPathSwap<T>(
  targetPath: string,
  replacementPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let swapped = false;
  const injectedLstat = async (...args: Parameters<typeof lstat>) => {
    const metadata = await Reflect.apply(original.lstat, undefined, args);
    if (String(args[0]) === targetPath && !swapped) {
      swapped = true;
      await original.rm(targetPath);
      await original.symlink(replacementPath, targetPath);
    }
    return metadata;
  };
  const mockedLstat = vi.mocked(lstat);
  mockedLstat.mockImplementation(injectedLstat as typeof lstat);
  try {
    return await operation();
  } finally {
    mockedLstat.mockImplementation(original.lstat);
  }
}

function cleanGit(root: string): NonNullable<WorkspaceToolsDeps["git"]> {
  const head = "a".repeat(40);
  return async (_cwd, args) => {
    if (args[0] === "worktree") {
      return {
        exitCode: 0,
        stdout: `worktree ${root}\0HEAD ${head}\0branch refs/heads/main\0\0`,
      };
    }
    if (args[0] === "status") return { exitCode: 0, stdout: "" };
    if (args[0] === "rev-parse") return { exitCode: 0, stdout: `${head}\n` };
    if (args[0] === "merge-base") return { exitCode: 0, stdout: "" };
    return { exitCode: 2, stdout: "" };
  };
}

describe("workspace footprint", () => {
  it("reads the verified .gitignore file even if its path is replaced after metadata lookup", async () => {
    const { base, root } = await repository();
    const ignorePath = join(root, ".gitignore");
    const replacementPath = join(base, "replacement.gitignore");
    await writeFile(replacementPath, "*.log\n");

    const lines = await withLstatPathSwap(ignorePath, replacementPath, () =>
      workspaceStatus(root, { cwd: root, pathEnv: "" }));

    expect(lines).toContain("Gitignore: ignored");
  });

  it("reports a missing .gitignore as not ignored", async () => {
    const { root } = await repository();
    await rm(join(root, ".gitignore"));

    const lines = await workspaceStatus(root, { cwd: root, pathEnv: "" });

    expect(lines).toContain("Gitignore: not ignored");
  });

  it("reports every run with an exclusive settled, unsettled, and compacted breakdown", async () => {
    const { root } = await repository();
    await seedRun(root, "settled", "complete");
    await seedRun(root, "unsettled", "running");
    const store = await seedRun(root, "compacted", "complete");
    await store.compact("compacted", CLEANLINESS_PROOF);

    const lines = await workspaceStatus(root, { cwd: root, pathEnv: "" });

    expect(lines).toContain("Runs: 3 (settled: 1, unsettled: 1, compacted: 1)");
    expect(lines.findIndex((line) => line.startsWith("Runs:"))).toBe(
      lines.findIndex((line) => line.startsWith("Workspace bytes:")) + 1,
    );
  });

  it.each([
    ["corrupt ledger", "corrupt", "corrupt_ledger"],
    ["future schema", "future", "future_schema"],
  ] as const)("reports usable workspace status and names a %s run without counting it as settled", async (
    _name,
    runId,
    code,
  ) => {
    const { root } = await repository();
    await seedRun(root, "settled", "complete");
    await seedRun(root, runId, "complete");
    const unreadableLedger = ledger(root, runId);
    const completeLedger = await readFile(unreadableLedger, "utf8");
    const unreadable = code === "corrupt_ledger"
      ? completeLedger.slice(0, -1)
      : `${completeLedger.trimEnd().split("\n").map((line, index) => {
        const event = JSON.parse(line) as Record<string, unknown>;
        return JSON.stringify(index === 0 ? { ...event, schemaVersion: 2 } : event);
      }).join("\n")}\n`;
    await writeFile(unreadableLedger, unreadable, "utf8");

    const lines = await workspaceStatus(root, { cwd: root, pathEnv: "" });

    expect(lines).toContain(`Resolved repository: ${root}`);
    expect(lines).toContain(`Bearing workspace: ${join(root, ".bearing")}`);
    expect(lines.some((line) => /^Workspace bytes: \d+ bytes$/.test(line))).toBe(true);
    expect(lines).toContain("Runs: 2 (settled: 1, unsettled: 0, compacted: 0, unreadable: 1)");
    expect(lines).toContain(`Unreadable runs: ${runId} (${code})`);
    expect(lines).toContain("Gitignore: ignored");
    expect(lines).toContain("Safety verdict: safe");
  });

  it("skips a corrupt snapshot but propagates snapshot EACCES", async () => {
    const { root } = await repository();
    await seedRun(root, "settled", "complete");
    await seedRun(root, "corrupt", "complete");
    const corruptPath = snapshot(root, "corrupt");
    const corruptSnapshot = (await readFile(corruptPath, "utf8"))
      .replace(/"hash":"[a-f0-9]{64}"/, `"hash":"${"0".repeat(64)}"`);
    await writeFile(corruptPath, corruptSnapshot, "utf8");

    const lines = await workspaceStatus(root, { cwd: root, pathEnv: "" });

    expect(lines).toContain("Runs: 2 (settled: 1, unsettled: 0, compacted: 0, unreadable: 1)");
    expect(lines).toContain("Unreadable runs: corrupt (corrupt_snapshot)");

    await seedRun(root, "blocked", "complete");
    const error = accessDenied(snapshot(root, "blocked"));
    await withReadFileError(error.path!, error, async () => {
      await expect(workspaceStatus(root, { cwd: root, pathEnv: "" })).rejects.toBe(error);
    });
  });

  it("reports a snapshot directory while healthy runs remain maintainable and EACCES still propagates", async () => {
    const { root } = await repository();
    await seedRun(root, "healthy", "complete");
    await seedRun(root, "damaged", "complete");
    const damagedLedgerPath = ledger(root, "damaged");
    const damagedSnapshotPath = snapshot(root, "damaged");
    const damagedLedger = await readFile(damagedLedgerPath);
    await rm(damagedSnapshotPath);
    await mkdir(damagedSnapshotPath);

    const lines = await workspaceStatus(root, { cwd: root, pathEnv: "" });

    expect(lines).toContain("Runs: 2 (settled: 1, unsettled: 0, compacted: 0, unreadable: 1)");
    expect(lines).toContain("Unreadable runs: damaged (corrupt_snapshot)");

    const compacted = await workspaceCompact({
      repository: root,
      policy: { compactSettled: true },
    });
    expect(compacted).toEqual({ ok: true, lines: ["Applied 1 compact action."] });
    expect(await readFile(ledger(root, "healthy"), "utf8")).toBe("");
    expect(await readFile(damagedLedgerPath)).toEqual(damagedLedger);
    expect((await stat(damagedSnapshotPath)).isDirectory()).toBe(true);

    const pruned = await workspacePrune({
      repository: root,
      policy: { maxCompletedRuns: 0 },
    });
    expect(pruned).toEqual({ ok: true, lines: ["Applied 1 prune action."] });
    await expect(access(join(root, ".bearing", "runs", "healthy"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(damagedLedgerPath)).toEqual(damagedLedger);
    expect((await stat(damagedSnapshotPath)).isDirectory()).toBe(true);

    await seedRun(root, "blocked", "complete");
    const error = accessDenied(snapshot(root, "blocked"));
    await withReadFileError(error.path!, error, async () => {
      await expect(workspaceStatus(root, { cwd: root, pathEnv: "" })).rejects.toBe(error);
    });
    expect(await readFile(damagedLedgerPath)).toEqual(damagedLedger);
  });
});

describe("workspace retention commands", () => {
  it.each([
    ["compact", workspaceCompact],
    ["prune", workspacePrune],
  ] as const)("refuses %s without an explicit policy and touches neither Git nor the store", async (_name, command) => {
    const { root } = await repository();
    let gitCalls = 0;
    let storeCalls = 0;
    const before = await readFile(join(root, "tracked.txt"));

    const result = await command({
      repository: root,
      onPlan: () => {
        throw new Error("plan callback must not run");
      },
    }, {
      git: async () => {
        gitCalls += 1;
        return { exitCode: 0, stdout: "" };
      },
      storeFactory: () => {
        storeCalls += 1;
        throw new Error("store must not be constructed");
      },
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.lines.join(" ")).toContain("explicit retention policy");
    expect(gitCalls).toBe(0);
    expect(storeCalls).toBe(0);
    expect(await readFile(join(root, "tracked.txt"))).toEqual(before);
  });

  it.each([
    ["compact", workspaceCompact, { compactSettled: true }, { runId: "settled", action: "compact", reason: "compact_settled" }],
    ["prune", workspacePrune, { maxCompletedRuns: 0 }, { runId: "settled", action: "prune", reason: "max_completed_runs" }],
  ] as const)("prints the %s plan before applying it and rechecks the live proof at action time", async (
    _name,
    command,
    policy,
    entry,
  ) => {
    const { root } = await repository();
    const events: string[] = [];
    const proofs: Array<CallerCleanlinessProof | undefined> = [];
    const fakeStore = {
      async retentionPlan(receivedPolicy?: RetentionPolicy, proof?: CallerCleanlinessProof): Promise<readonly RetentionPlanEntry[]> {
        events.push("plan");
        proofs.push(proof);
        expect(receivedPolicy).toEqual(policy);
        return [entry];
      },
      async applyRetention(receivedPolicy?: RetentionPolicy, proof?: CallerCleanlinessProof): Promise<readonly RetentionPlanEntry[]> {
        events.push("apply");
        proofs.push(proof);
        expect(receivedPolicy).toEqual(policy);
        return [entry];
      },
    };

    const result = await command({
      repository: root,
      policy,
      onPlan: (lines) => {
        events.push("print");
        expect(lines.join("\n")).toContain(`${entry.action} ${entry.runId} (${entry.reason})`);
      },
    }, {
      git: cleanGit(root),
      storeFactory: () => fakeStore,
      now: () => NOW,
    });

    expect(result).toEqual({ ok: true, lines: [`Applied 1 ${_name} action.`] });
    expect(events).toEqual(["plan", "print", "apply"]);
    expect(proofs).toEqual([CLEANLINESS_PROOF, CLEANLINESS_PROOF]);
  });

  it("passes no proof for a dirty linked worktree, so the store refuses without mutation", async () => {
    const { root } = await repository();
    await seedRun(root, "dirty-run", "complete");
    const before = await readFile(ledger(root, "dirty-run"));
    await writeFile(join(root, "tracked.txt"), "dirty\n");

    await expect(workspaceCompact({
      repository: root,
      policy: { compactSettled: true },
    })).rejects.toMatchObject({ code: "run_not_settled" });

    expect(await readFile(ledger(root, "dirty-run"))).toEqual(before);
  });

  it("discovers a clean but unmerged linked lane through Git and lets the store refuse pruning", async () => {
    const { base, root } = await repository();
    await seedRun(root, "unmerged-run", "complete");
    const before = await readFile(ledger(root, "unmerged-run"));
    const lane = join(base, "lane");
    await git(root, ["worktree", "add", "-qb", "unmerged-lane", lane]);
    await writeFile(join(lane, "tracked.txt"), "lane commit\n");
    await git(lane, ["add", "tracked.txt"]);
    await git(lane, ["commit", "-qm", "unmerged lane"]);

    await expect(workspacePrune({
      repository: root,
      policy: { maxCompletedRuns: 0 },
    })).rejects.toMatchObject({ code: "run_not_settled" });

    expect(await readFile(ledger(root, "unmerged-run"))).toEqual(before);
  });

  it("refuses when Git cannot determine the linked-worktree set", async () => {
    const { root } = await repository();
    let storeCalls = 0;

    await expect(workspaceCompact({
      repository: root,
      policy: { compactSettled: true },
    }, {
      git: async () => ({ exitCode: 2, stdout: "" }),
      storeFactory: () => {
        storeCalls += 1;
        throw new Error("store must not be reached");
      },
    })).rejects.toThrow(/could not determine.*worktree/i);

    expect(storeCalls).toBe(0);
  });
});

describe("repository busy lease", () => {
  async function writeLease(root: string, body: unknown): Promise<void> {
    const path = join(root, ".bearing", "busy-lease.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(body)}\n`);
  }

  it("refuses doctor relocation while the repository busy lease is live", async () => {
    const { base, root } = await repository();
    const workspace = join(root, ".bearing");
    const quarantine = join(root, ".bearing.quarantine-2026-07-25T12-00-00-000Z");
    await writeLease(root, {
      schemaVersion: 1,
      runIds: ["held-run"],
      expiresAt: "2026-07-25T12:00:30.000Z",
    });

    const result = await workspaceDoctor({
      scans: [root],
      relocate: workspace,
    }, {
      home: base,
      pathEnv: "",
      now: () => NOW,
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.lines).toContain(`Refusing relocation: a Bearing run is active in ${workspace}.`);
    await expect(access(workspace)).resolves.toBeUndefined();
    await expect(access(quarantine)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["absent", async (root: string) => mkdir(join(root, ".bearing"))],
    ["expired", async (root: string) => writeLease(root, {
      schemaVersion: 1,
      runIds: ["stale-run"],
      expiresAt: "2026-07-25T11:59:59.999Z",
    })],
  ] as const)("relocates when the repository busy lease is %s", async (_name, arrange) => {
    const { base, root } = await repository();
    const workspace = join(root, ".bearing");
    const quarantine = join(root, ".bearing.quarantine-2026-07-25T12-00-00-000Z");
    await arrange(root);

    const result = await workspaceDoctor({
      scans: [root],
      relocate: workspace,
    }, {
      home: base,
      pathEnv: "",
      now: () => NOW,
    });

    expect(result).toEqual({
      ok: true,
      lines: [
        `OK: ${workspace} — repository workspace is safe.`,
        `Relocated: ${workspace} -> ${quarantine}`,
      ],
    });
    await expect(access(workspace)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(quarantine)).resolves.toBeUndefined();
  });

  it("blocks compact while held but ignores an expired lease after the bounded staleness window", async () => {
    const held = await repository();
    await seedRun(held.root, "held-run", "complete");
    const heldBefore = await readFile(ledger(held.root, "held-run"));
    await writeLease(held.root, {
      schemaVersion: 1,
      runIds: ["held-run"],
      expiresAt: "2026-07-25T12:00:30.000Z",
    });

    await expect(workspaceCompact({
      repository: held.root,
      policy: { compactSettled: true },
    }, {
      git: cleanGit(held.root),
      now: () => NOW,
    })).rejects.toMatchObject({ code: "run_not_settled" });
    expect(await readFile(ledger(held.root, "held-run"))).toEqual(heldBefore);

    const stale = await repository();
    await seedRun(stale.root, "stale-run", "complete");
    await writeLease(stale.root, {
      schemaVersion: 1,
      runIds: ["stale-run"],
      expiresAt: "2026-07-25T11:59:59.999Z",
    });

    const result = await workspaceCompact({
      repository: stale.root,
      policy: { compactSettled: true },
    }, {
      git: cleanGit(stale.root),
      now: () => NOW,
    });

    expect(result.ok).toBe(true);
    expect(await readFile(ledger(stale.root, "stale-run"), "utf8")).toBe("");
  });

  it.each([
    ["malformed", async (root: string) => writeLease(root, { schemaVersion: 1, runIds: ["run"], expiresAt: "not-a-date" })],
    ["ambiguous", async (root: string) => writeLease(root, { schemaVersion: 1, runIds: ["run"], expiresAt: "2026-07-25T12:00:30.000Z", extra: true })],
    ["unreadable", async (root: string) => mkdir(join(root, ".bearing", "busy-lease.json"))],
  ] as const)("refuses an %s lease instead of assuming idle", async (_name, arrange) => {
    const { root } = await repository();
    await mkdir(join(root, ".bearing"), { recursive: true });
    await arrange(root);
    let storeCalls = 0;

    await expect(workspacePrune({
      repository: root,
      policy: { maxAgeDays: 1 },
    }, {
      git: cleanGit(root),
      now: () => NOW,
      storeFactory: () => {
        storeCalls += 1;
        throw new Error("store must not be reached");
      },
    })).rejects.toThrow(/busy lease.*unreadable or ambiguous/i);

    expect(storeCalls).toBe(0);
  });

  it("refuses to publish through a symlinked workspace outside the selected repository", async () => {
    const { base, root } = await repository();
    const outside = join(base, "outside");
    await mkdir(outside);
    await symlink(outside, join(root, ".bearing"));

    await expect(writeWorkspaceBusyLease(root, ["run-1"], NOW))
      .rejects.toThrow(/workspace.*symlink|outside/i);
    await expect(access(join(outside, "busy-lease.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses busy lease state inspection when .bearing is symlinked outside", async () => {
    const { base, root } = await repository();
    const outside = join(base, "outside-busy");
    await mkdir(outside);
    await symlink(outside, join(root, ".bearing"));

    let storeCalls = 0;
    await expect(workspacePrune({
      repository: root,
      policy: { maxAgeDays: 1 },
    }, {
      git: cleanGit(root),
      now: () => NOW,
      storeFactory: () => {
        storeCalls += 1;
        throw new Error("store must not be reached");
      },
    })).rejects.toThrow(/busy lease.*unreadable or ambiguous/i);
    expect(storeCalls).toBe(0);
  });
});
