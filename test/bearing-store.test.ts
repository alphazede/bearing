import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalStringify, hashEvent, parseEventEnvelope, type CommandEnvelopeV1, type EventEnvelopeV1 } from "../src/contracts/run.js";
import {
  BearingStore,
  BearingStoreError,
  isStoreIntegrityError,
  type CallerCleanlinessProof,
  type FaultBoundary,
  type RetentionPlanEntry,
  type RetentionPolicy,
} from "../src/store/bearing-store.js";
import { replay } from "../src/workflow/aggregate.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, readFile: vi.fn(original.readFile) };
});

const roots: string[] = [];
const RUN = "run-1";
const SESSION = { sessionId: "session-1", actor: "owner" };
const CLEANLINESS_PROOF = {
  noDirtyOrUnmergedLane: true,
  runNotBusy: true,
} as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "bearing-store-"));
  roots.push(value);
  return value;
}

function command(
  commandId: string,
  type: CommandEnvelopeV1["type"],
  expectedRevision: number,
  payload?: Readonly<Record<string, unknown>>,
): CommandEnvelopeV1 {
  const base = {
    schemaVersion: 1 as const,
    commandId,
    runId: RUN,
    expectedRevision,
    session: SESSION,
    correlationId: "correlation-1",
  };
  if (type === "createWorkRequest") {
    return { ...base, type, payload: payload ?? { title: "Title", goal: "Goal" } } as unknown as CommandEnvelopeV1;
  }
  if (type === "requireDecision") {
    return {
      ...base,
      type,
      payload: payload ?? { decisionId: "decision-1", question: "Proceed?", consequential: true },
    } as unknown as CommandEnvelopeV1;
  }
  return {
    ...base,
    type,
    payload: payload ?? { decisionId: "decision-1", answer: "Yes" },
  } as unknown as CommandEnvelopeV1;
}

function store(rootDir: string, fail?: FaultBoundary): BearingStore {
  let id = 0;
  return new BearingStore(rootDir, {
    now: () => "2026-07-19T12:00:00.000Z",
    nextEventId: () => `event-${++id}`,
    fault: fail === undefined ? undefined : (boundary) => {
      if (boundary === fail) throw new Error(`injected ${boundary}`);
    },
  });
}

function runPath(rootDir: string, runId = RUN): string {
  return join(rootDir, ".bearing", "runs", runId);
}

function ledgerPath(rootDir: string, runId = RUN): string {
  return join(runPath(rootDir, runId), "events.jsonl");
}

function snapshotPath(rootDir: string, runId = RUN): string {
  return join(runPath(rootDir, runId), "snapshot.json");
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

async function acceptedCreate(rootDir: string): Promise<void> {
  const result = await store(rootDir).apply(command("create-1", "createWorkRequest", 0));
  expect(result.ok).toBe(true);
}

function checkpointCommand(
  commandId: string,
  expectedRevision: number,
  status: "running" | "waiting" | "stopped" | "failed" | "complete",
  stage: "set-bearings" | "review" = "review",
): CommandEnvelopeV1 {
  return {
    schemaVersion: 1,
    commandId,
    runId: RUN,
    expectedRevision,
    session: { sessionId: "session-bearing", actor: "bearing" },
    correlationId: "correlation-1",
    type: "recordJourneyCheckpoint",
    payload: {
      stage,
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

async function acceptedComplete(rootDir: string): Promise<void> {
  await acceptedCreate(rootDir);
  const result = await store(rootDir).apply(checkpointCommand("checkpoint-1", 1, "complete"));
  expect(result.ok).toBe(true);
}

async function recordRun(
  durable: BearingStore,
  runId: string,
  status: "running" | "waiting" | "stopped" | "failed" | "complete",
): Promise<void> {
  const created = await durable.apply({
    ...command(`${runId}-create`, "createWorkRequest", 0),
    runId,
  });
  expect(created.ok).toBe(true);
  const checkpoint = await durable.apply({
    ...checkpointCommand(`${runId}-checkpoint`, 1, status),
    runId,
  });
  expect(checkpoint.ok).toBe(true);
}

async function storedRunFingerprint(rootDir: string, runId: string): Promise<unknown> {
  const directory = runPath(rootDir, runId);
  const [directoryStat, ledgerStat, snapshotStat, ledger, snapshot] = await Promise.all([
    stat(directory),
    stat(ledgerPath(rootDir, runId)),
    stat(snapshotPath(rootDir, runId)),
    readFile(ledgerPath(rootDir, runId), "utf8"),
    readFile(snapshotPath(rootDir, runId), "utf8"),
  ]);
  return {
    directoryMtimeMs: directoryStat.mtimeMs,
    ledgerMtimeMs: ledgerStat.mtimeMs,
    snapshotMtimeMs: snapshotStat.mtimeMs,
    ledger,
    snapshot,
  };
}

async function makeLedgerUnreadable(
  rootDir: string,
  runId: string,
  code: "corrupt_ledger" | "future_schema",
): Promise<string> {
  const path = ledgerPath(rootDir, runId);
  const original = await readFile(path, "utf8");
  const unreadable = code === "corrupt_ledger"
    ? original.slice(0, -1)
    : `${original.trimEnd().split("\n").map((line, index) => {
      const event = JSON.parse(line) as EventEnvelopeV1;
      return JSON.stringify(index === 0 ? { ...event, schemaVersion: 2 } : event);
    }).join("\n")}\n`;
  await writeFile(path, unreadable, "utf8");
  return unreadable;
}

describe("store integrity errors", () => {
  it("classifies every read-integrity code and no operational or caller error", () => {
    const integrityCodes = [
      "corrupt_ledger",
      "future_schema",
      "event_hash_mismatch",
      "previous_hash_mismatch",
      "sequence_mismatch",
      "wrong_run_id",
      "corrupt_snapshot",
    ] as const;
    const otherStoreCodes = [
      "invalid_run_id",
      "ledger_write_failed",
      "run_not_settled",
      "run_compacted",
    ] as const;

    expect(integrityCodes.every((code) =>
      isStoreIntegrityError(new BearingStoreError(code, code)))).toBe(true);
    expect(otherStoreCodes.some((code) =>
      isStoreIntegrityError(new BearingStoreError(code, code)))).toBe(false);
    expect(isStoreIntegrityError(new Error("unexpected"))).toBe(false);
  });
});

describe("durability boundaries", () => {
  const beforeSync: FaultBoundary[] = [
    "before-ledger-append",
    "after-ledger-append",
    "before-ledger-file-sync",
    "after-ledger-file-sync",
    "before-ledger-parent-directory-sync",
  ];

  for (const boundary of beforeSync) {
    it(`${boundary} is not acknowledged or recovered`, async () => {
      const dir = await root();
      await expect(store(dir, boundary).apply(command("create-1", "createWorkRequest", 0)))
        .rejects.toMatchObject({ code: "ledger_write_failed" });
      expect((await store(dir).load(RUN)).revision).toBe(0);
    });
  }

  const afterSync: FaultBoundary[] = [
    "after-ledger-parent-directory-sync",
    "before-snapshot-temp-write",
    "after-snapshot-temp-write",
    "before-snapshot-temp-file-sync",
    "after-snapshot-temp-file-sync",
    "before-snapshot-rename",
    "after-snapshot-rename",
    "before-snapshot-parent-directory-sync",
    "after-snapshot-parent-directory-sync",
  ];

  for (const boundary of afterSync) {
    it(`${boundary} returns durable acceptance and reloads exactly once`, async () => {
      const dir = await root();
      const result = await store(dir, boundary).apply(command("create-1", "createWorkRequest", 0));
      expect(result).toMatchObject({
        ok: true,
        durable: true,
        snapshotWarning: { code: "snapshot_update_failed", boundary },
      });
      const loaded = await store(dir).load(RUN);
      expect(loaded.revision).toBe(1);
      expect(loaded.outcomes.get("create-1")?.eventIds).toHaveLength(1);
    });
  }
});

describe("restart and serialization", () => {
  it("lists durable work requests for local session history", async () => {
    const dir = await root();
    await acceptedCreate(dir);
    expect(await store(dir).list()).toEqual([expect.objectContaining({ runId: RUN, title: "Title", goal: "Goal", updatedAt: "2026-07-19T12:00:00.000Z" })]);
  });

  it.each([
    ["a corrupt ledger", "corrupt_ledger"],
    ["a future-schema ledger", "future_schema"],
  ] as const)("lists healthy runs and marks %s as unreadable", async (_name, code) => {
    const dir = await root();
    const durable = store(dir);
    await durable.apply({ ...command("healthy-create", "createWorkRequest", 0), runId: "healthy" });
    await durable.apply({ ...command("unreadable-create", "createWorkRequest", 0), runId: "unreadable" });
    await makeLedgerUnreadable(dir, "unreadable", code);
    const unreadableUpdatedAt = new Date((await stat(ledgerPath(dir, "unreadable"))).mtimeMs).toISOString();

    const entries = await durable.list();

    const healthy = entries.find((entry) => entry.runId === "healthy");
    expect(healthy).toMatchObject({ title: "Title", goal: "Goal" });
    expect(healthy).not.toHaveProperty("unreadable");
    expect(entries.find((entry) => entry.runId === "unreadable")).toEqual({
      runId: "unreadable",
      title: "Unreadable run: unreadable",
      goal: `Integrity check failed (${code}). Bearing left this run untouched.`,
      updatedAt: unreadableUpdatedAt,
      unreadable: true,
      integrityError: code,
    });
  });

  it.each(["ENOTDIR", "ELOOP", "EFTYPE"] as const)(
    "classifies snapshot %s as malformed store structure",
    async (code) => {
      const dir = await root();
      await acceptedCreate(dir);
      const path = snapshotPath(dir);
      const error = Object.assign(new Error(`${code}: malformed snapshot path '${path}'`), {
        code,
        path,
      });

      await withReadFileError(path, error, async () => {
        await expect(store(dir).load(RUN)).rejects.toMatchObject({
          code: "corrupt_snapshot",
          cause: error,
        });
      });
    },
  );

  it("deletes one history entry or clears all entries", async () => {
    const dir = await root();
    const durable = store(dir);
    await durable.apply(command("create-1", "createWorkRequest", 0));
    await durable.apply({ ...command("create-2", "createWorkRequest", 0), runId: "run-2" });
    await durable.delete(RUN);
    expect((await durable.list()).map((entry) => entry.runId)).toEqual(["run-2"]);
    await durable.clear();
    expect(await durable.list()).toEqual([]);
  });

  it("restores idempotency, conflicts, and pending decisions", async () => {
    const dir = await root();
    const first = store(dir);
    await first.apply(command("create-1", "createWorkRequest", 0));
    const require = command("require-1", "requireDecision", 1);
    await first.apply(require);

    const restarted = store(dir);
    expect((await restarted.load(RUN)).pendingDecision).toEqual({
      decisionId: "decision-1",
      question: "Proceed?",
    });
    const duplicate = await restarted.apply(require);
    expect(duplicate.ok && duplicate.events).toEqual([]);
    const conflict = await restarted.apply(command(
      "require-1",
      "requireDecision",
      1,
      { decisionId: "decision-1", question: "Different?", consequential: true },
    ));
    expect(conflict.ok ? "ok" : conflict.reason).toBe("conflicting_duplicate");
    expect((await restarted.load(RUN)).revision).toBe(2);
  });

  it("serializes concurrent commands at the same revision", async () => {
    const dir = await root();
    const durable = store(dir);
    await durable.apply(command("create-1", "createWorkRequest", 0));
    const [a, b] = await Promise.all([
      durable.apply(command("require-a", "requireDecision", 1)),
      store(dir).apply(command(
        "require-b",
        "requireDecision",
        1,
        { decisionId: "decision-2", question: "Other?", consequential: true },
      )),
    ]);
    expect([a, b].filter((result) => result.ok)).toHaveLength(1);
    expect([a, b].find((result) => !result.ok)).toMatchObject({ reason: "stale_revision" });
    expect((await durable.load(RUN)).revision).toBe(2);
  });

  it("rejects path-shaped run ids", async () => {
    const dir = await root();
    await expect(store(dir).load("../escape")).rejects.toMatchObject({ code: "invalid_run_id" });
  });
});

describe("snapshot projection", () => {
  it("applies a verified ledger tail to a stale snapshot", async () => {
    const dir = await root();
    await acceptedCreate(dir);
    const second = await store(dir, "before-snapshot-temp-write").apply(
      command("require-1", "requireDecision", 1),
    );
    expect(second.ok).toBe(true);

    const loaded = await store(dir).load(RUN);
    const events = (await readFile(ledgerPath(dir), "utf8")).trimEnd().split("\n").map((line) => {
      const parsed = parseEventEnvelope(JSON.parse(line));
      if (!parsed.ok) throw new Error("test ledger parse failed");
      return parsed.value;
    });
    const full = replay(events);
    expect(loaded.revision).toBe(full.revision);
    expect(loaded.pendingDecision).toEqual(full.pendingDecision);
    expect([...loaded.outcomes]).toEqual([...full.outcomes]);
  });

  it("ignores an interrupted temp snapshot", async () => {
    const dir = await root();
    await acceptedCreate(dir);
    await writeFile(`${snapshotPath(dir)}.tmp`, "{interrupted", "utf8");
    expect((await store(dir).load(RUN)).revision).toBe(1);
  });

  it.each([
    ["corrupt", (snapshot: string) => snapshot.replace(/"hash":"[a-f0-9]{64}"/, `"hash":"${"0".repeat(64)}"`), "corrupt_snapshot"],
    ["future", (snapshot: string) => snapshot.replace('"schemaVersion":1', '"schemaVersion":2'), "future_schema"],
  ])("blocks a %s snapshot", async (_name, mutate, code) => {
    const dir = await root();
    await acceptedCreate(dir);
    const path = snapshotPath(dir);
    await writeFile(path, mutate(await readFile(path, "utf8")), "utf8");
    await expect(store(dir).load(RUN)).rejects.toMatchObject({ code });
  });
});

describe("settled-run compaction", () => {
  it("refuses an event-settled run without the caller's live cleanliness proof", async () => {
    const dir = await root();
    await acceptedComplete(dir);
    const before = await storedRunFingerprint(dir, RUN);

    await expect(store(dir).compact(RUN)).rejects.toMatchObject({ code: "run_not_settled" });

    expect(await storedRunFingerprint(dir, RUN)).toEqual(before);
  });

  it.each(["running", "waiting", "stopped", "failed"] as const)(
    "refuses a %s run and leaves its ledger byte-identical",
    async (status) => {
      const dir = await root();
      await acceptedCreate(dir);
      expect((await store(dir).apply(checkpointCommand("checkpoint-1", 1, status))).ok).toBe(true);
      const before = await readFile(ledgerPath(dir));

      await expect(store(dir).compact(RUN, CLEANLINESS_PROOF))
        .rejects.toMatchObject({ code: "run_not_settled" });

      expect(Buffer.compare(await readFile(ledgerPath(dir)), before)).toBe(0);
      expect((await store(dir).load(RUN)).revision).toBe(2);
    },
  );

  it("refuses a pending-decision run and leaves its ledger byte-identical", async () => {
    const dir = await root();
    await acceptedComplete(dir);
    expect((await store(dir).apply(command("require-1", "requireDecision", 2))).ok).toBe(true);
    const before = await readFile(ledgerPath(dir));

    await expect(store(dir).compact(RUN, CLEANLINESS_PROOF))
      .rejects.toMatchObject({ code: "run_not_settled" });

    expect(Buffer.compare(await readFile(ledgerPath(dir)), before)).toBe(0);
  });

  it("refuses a non-final complete checkpoint", async () => {
    const dir = await root();
    await acceptedCreate(dir);
    expect((await store(dir).apply(checkpointCommand("checkpoint-1", 1, "complete", "set-bearings"))).ok).toBe(true);
    const before = await readFile(ledgerPath(dir));

    await expect(store(dir).compact(RUN, CLEANLINESS_PROOF))
      .rejects.toMatchObject({ code: "run_not_settled" });

    expect(Buffer.compare(await readFile(ledgerPath(dir)), before)).toBe(0);
  });

  it("compacts a settled run, then loads, lists, and seals it against commands", async () => {
    const dir = await root();
    let now = "2026-07-19T12:00:00.000Z";
    let id = 0;
    const durable = new BearingStore(dir, {
      now: () => now,
      nextEventId: () => `event-${++id}`,
    });
    expect((await durable.apply(command("create-1", "createWorkRequest", 0))).ok).toBe(true);
    now = "2026-07-19T12:05:00.000Z";
    expect((await durable.apply(checkpointCommand("checkpoint-1", 1, "complete"))).ok).toBe(true);
    const lines = (await readFile(ledgerPath(dir), "utf8")).trimEnd().split("\n");
    const last = JSON.parse(lines.at(-1)!) as EventEnvelopeV1;
    now = "2026-07-19T12:10:00.000Z";

    const compacted = await durable.compact(RUN, CLEANLINESS_PROOF);

    expect(await readFile(ledgerPath(dir), "utf8")).toBe("");
    expect(JSON.parse(await readFile(snapshotPath(dir), "utf8"))).toMatchObject({
      revision: 2,
      lastEventHash: last.hash,
      compacted: {
        atSequence: 2,
        atEventHash: last.hash,
        compactedAt: "2026-07-19T12:10:00.000Z",
      },
      summary: {
        title: "Title",
        goal: "Goal",
        updatedAt: "2026-07-19T12:05:00.000Z",
      },
    });
    expect(compacted).toMatchObject({
      runId: RUN,
      revision: 2,
      events: [],
      sealed: true,
      journeyCheckpoint: {
        status: "complete",
        artifacts: ["docs/plans/run/review.html"],
      },
    });
    expect(await store(dir).load(RUN)).toMatchObject(compacted);
    expect(await store(dir).list()).toEqual([expect.objectContaining({
      runId: RUN,
      title: "Title",
      goal: "Goal",
      updatedAt: "2026-07-19T12:05:00.000Z",
      checkpoint: expect.objectContaining({ artifacts: ["docs/plans/run/review.html"] }),
    })]);
    await rm(ledgerPath(dir));
    expect((await store(dir).list()).map((entry) => entry.runId)).toEqual([RUN]);
    await expect(store(dir).apply(command("post-compact", "requireDecision", 2)))
      .rejects.toMatchObject({ code: "run_compacted" });
  });

  it("leaves the ledger intact when the compacted snapshot is not committed", async () => {
    const dir = await root();
    await acceptedComplete(dir);
    const before = await readFile(ledgerPath(dir));

    await expect(store(dir, "before-snapshot-rename").compact(RUN, CLEANLINESS_PROOF))
      .rejects.toThrow("snapshot update failed");

    expect(Buffer.compare(await readFile(ledgerPath(dir)), before)).toBe(0);
    expect((await store(dir).load(RUN)).events).toHaveLength(2);
  });

  it("keeps the full ledger recoverable when snapshot commit reports a later failure", async () => {
    const dir = await root();
    await acceptedComplete(dir);
    const before = await readFile(ledgerPath(dir));

    await expect(store(dir, "after-snapshot-parent-directory-sync").compact(RUN, CLEANLINESS_PROOF))
      .rejects.toThrow("snapshot update failed");

    expect(Buffer.compare(await readFile(ledgerPath(dir)), before)).toBe(0);
    expect(await store(dir).load(RUN)).toMatchObject({ sealed: true, revision: 2 });
    await store(dir).compact(RUN, CLEANLINESS_PROOF);
    expect(await readFile(ledgerPath(dir), "utf8")).toBe("");
  });

  it("rebuilds a stale snapshot after a nonfatal snapshot warning before compacting", async () => {
    const dir = await root();
    await acceptedCreate(dir);
    const checkpoint = await store(dir, "before-snapshot-temp-write").apply(
      checkpointCommand("checkpoint-1", 1, "complete"),
    );
    expect(checkpoint).toMatchObject({
      ok: true,
      snapshotWarning: {
        code: "snapshot_update_failed",
        boundary: "before-snapshot-temp-write",
      },
    });
    expect(JSON.parse(await readFile(snapshotPath(dir), "utf8"))).toMatchObject({ revision: 1 });

    const compacted = await store(dir).compact(RUN, CLEANLINESS_PROOF);

    expect(compacted).toMatchObject({ runId: RUN, revision: 2, sealed: true });
    expect(await readFile(ledgerPath(dir), "utf8")).toBe("");
    expect(JSON.parse(await readFile(snapshotPath(dir), "utf8"))).toMatchObject({
      revision: 2,
      compacted: { atSequence: 2 },
    });
  });

  it("replays and verifies the full ledger projection before truncating it", async () => {
    const dir = await root();
    await acceptedComplete(dir);
    const before = await readFile(ledgerPath(dir));
    const snapshot = JSON.parse(await readFile(snapshotPath(dir), "utf8")) as Record<string, unknown>;
    const { hash: _hash, ...body } = { ...snapshot, workRequestCreated: false } as Record<string, unknown>;
    const corrupted = { ...body, hash: createHash("sha256").update(canonicalStringify(body)).digest("hex") };
    await writeFile(snapshotPath(dir), `${JSON.stringify(corrupted)}\n`, "utf8");

    await expect(store(dir).compact(RUN, CLEANLINESS_PROOF))
      .rejects.toMatchObject({ code: "corrupt_snapshot" });

    expect(Buffer.compare(await readFile(ledgerPath(dir)), before)).toBe(0);
  });
});

describe("store retention", () => {
  it("is a byte-and-mtime no-op when the policy is absent or empty", async () => {
    const dir = await root();
    await acceptedComplete(dir);
    const durable = store(dir);
    const before = await storedRunFingerprint(dir, RUN);

    expect(await durable.retentionPlan()).toEqual([]);
    expect(await durable.retentionPlan({})).toEqual([]);
    expect(await durable.applyRetention()).toEqual([]);
    expect(await durable.applyRetention({})).toEqual([]);

    expect(await storedRunFingerprint(dir, RUN)).toEqual(before);
    expect(await readdir(join(dir, ".bearing", "runs"))).toEqual([RUN]);
  });

  it("refuses an active policy without the caller's live cleanliness proof", async () => {
    const dir = await root();
    await acceptedComplete(dir);
    const durable = store(dir);
    const before = await storedRunFingerprint(dir, RUN);

    await expect(durable.retentionPlan({ compactSettled: true }))
      .rejects.toMatchObject({ code: "run_not_settled" });
    await expect(durable.applyRetention({ maxCompletedRuns: 0 }))
      .rejects.toMatchObject({ code: "run_not_settled" });

    expect(await storedRunFingerprint(dir, RUN)).toEqual(before);
  });

  it.each([
    [{ maxAgeDays: 2 }, "max_age_days"],
    [{ maxCompletedRuns: 1 }, "max_completed_runs"],
  ] as const)(
    "excludes running and pending-decision runs under policy %j",
    async (policy, reason) => {
      const dir = await root();
      let now = "2026-07-01T12:00:00.000Z";
      let id = 0;
      const durable = new BearingStore(dir, {
        now: () => now,
        nextEventId: () => `retention-event-${++id}`,
      });
      await recordRun(durable, "old-complete", "complete");
      await recordRun(durable, "old-running", "running");
      await recordRun(durable, "old-pending", "complete");
      expect((await durable.apply({
        ...command("old-pending-decision", "requireDecision", 2),
        runId: "old-pending",
      })).ok).toBe(true);
      now = "2026-07-09T12:00:00.000Z";
      await recordRun(durable, "new-complete", "complete");
      now = "2026-07-10T12:00:00.000Z";

      expect(await durable.retentionPlan(policy, CLEANLINESS_PROOF)).toEqual([{
        runId: "old-complete",
        action: "prune",
        reason,
      }]);
    },
  );

  it("plans compaction only for settled, uncompacted runs without mutating them", async () => {
    const dir = await root();
    let id = 0;
    const durable = new BearingStore(dir, {
      now: () => "2026-07-19T12:00:00.000Z",
      nextEventId: () => `retention-event-${++id}`,
    });
    await recordRun(durable, "settled", "complete");
    await recordRun(durable, "running", "running");
    const before = await storedRunFingerprint(dir, "settled");

    expect(await durable.retentionPlan({ compactSettled: true }, CLEANLINESS_PROOF)).toEqual([{
      runId: "settled",
      action: "compact",
      reason: "compact_settled",
    }]);

    expect(await storedRunFingerprint(dir, "settled")).toEqual(before);
  });

  it("applies exactly its plan through compaction and the existing prune path", async () => {
    const dir = await root();
    let now = "2026-07-01T12:00:00.000Z";
    let id = 0;
    const durable = new BearingStore(dir, {
      now: () => now,
      nextEventId: () => `retention-event-${++id}`,
    });
    await recordRun(durable, "oldest", "complete");
    now = "2026-07-02T12:00:00.000Z";
    await recordRun(durable, "middle", "complete");
    now = "2026-07-03T12:00:00.000Z";
    await recordRun(durable, "newest", "complete");
    await recordRun(durable, "running", "running");
    now = "2026-07-10T12:00:00.000Z";
    const policy = { maxCompletedRuns: 1, compactSettled: true } as const;
    const plan = await durable.retentionPlan(policy, CLEANLINESS_PROOF);
    const runningBefore = await storedRunFingerprint(dir, "running");

    expect(plan).toEqual([
      { runId: "oldest", action: "prune", reason: "max_completed_runs" },
      { runId: "middle", action: "prune", reason: "max_completed_runs" },
      { runId: "newest", action: "compact", reason: "compact_settled" },
    ]);
    expect(await durable.applyRetention(policy, CLEANLINESS_PROOF)).toEqual(plan);

    expect((await readdir(join(dir, ".bearing", "runs"))).sort()).toEqual(["newest", "running"]);
    expect(await readFile(ledgerPath(dir, "newest"), "utf8")).toBe("");
    expect(await storedRunFingerprint(dir, "running")).toEqual(runningBefore);
  });

  it("stops on snapshot EACCES while still isolating genuine snapshot corruption", async () => {
    const dir = await root();
    const durable = store(dir);
    await recordRun(durable, "healthy", "complete");
    await recordRun(durable, "corrupt", "complete");
    await recordRun(durable, "blocked", "complete");
    const corruptPath = snapshotPath(dir, "corrupt");
    const corruptSnapshot = (await readFile(corruptPath, "utf8"))
      .replace(/"hash":"[a-f0-9]{64}"/, `"hash":"${"0".repeat(64)}"`);
    await writeFile(corruptPath, corruptSnapshot, "utf8");
    const healthyBefore = await storedRunFingerprint(dir, "healthy");
    const blockedBefore = await storedRunFingerprint(dir, "blocked");
    const error = accessDenied(snapshotPath(dir, "blocked"));

    await withReadFileError(error.path!, error, async () => {
      await expect(durable.applyRetention(
        { maxCompletedRuns: 0 },
        CLEANLINESS_PROOF,
      )).rejects.toBe(error);
    });

    expect(await storedRunFingerprint(dir, "healthy")).toEqual(healthyBefore);
    expect(await storedRunFingerprint(dir, "blocked")).toEqual(blockedBefore);
    expect(await readFile(corruptPath, "utf8")).toBe(corruptSnapshot);
    expect(await durable.retentionPlan(
      { maxCompletedRuns: 0 },
      CLEANLINESS_PROOF,
    )).toContainEqual({
      runId: "corrupt",
      action: "skip",
      reason: "corrupt_snapshot",
    });
  });

  it("isolates a snapshot directory from listing, compaction, and pruning while EACCES still stops maintenance", async () => {
    const dir = await root();
    const durable = store(dir);
    await recordRun(durable, "healthy", "complete");
    await recordRun(durable, "damaged", "complete");
    const damagedLedgerPath = ledgerPath(dir, "damaged");
    const damagedSnapshotPath = snapshotPath(dir, "damaged");
    const damagedLedger = await readFile(damagedLedgerPath);
    await rm(damagedSnapshotPath);
    await mkdir(damagedSnapshotPath);

    const entries = await durable.list();

    expect(entries.find((entry) => entry.runId === "healthy")).toMatchObject({
      runId: "healthy",
      title: "Title",
    });
    expect(entries.find((entry) => entry.runId === "damaged")).toMatchObject({
      runId: "damaged",
      unreadable: true,
      integrityError: "corrupt_snapshot",
    });

    const compactPolicy = { compactSettled: true } as const;
    expect(await durable.retentionPlan(compactPolicy, CLEANLINESS_PROOF)).toEqual([
      { runId: "healthy", action: "compact", reason: "compact_settled" },
      { runId: "damaged", action: "skip", reason: "corrupt_snapshot" },
    ]);
    expect(await durable.applyRetention(compactPolicy, CLEANLINESS_PROOF)).toEqual([
      { runId: "healthy", action: "compact", reason: "compact_settled" },
    ]);
    expect(await readFile(ledgerPath(dir, "healthy"), "utf8")).toBe("");
    expect(await readFile(damagedLedgerPath)).toEqual(damagedLedger);
    expect((await stat(damagedSnapshotPath)).isDirectory()).toBe(true);

    const prunePolicy = { maxCompletedRuns: 0 } as const;
    expect(await durable.retentionPlan(prunePolicy, CLEANLINESS_PROOF)).toEqual([
      { runId: "healthy", action: "prune", reason: "max_completed_runs" },
      { runId: "damaged", action: "skip", reason: "corrupt_snapshot" },
    ]);
    expect(await durable.applyRetention(prunePolicy, CLEANLINESS_PROOF)).toEqual([
      { runId: "healthy", action: "prune", reason: "max_completed_runs" },
    ]);
    expect(await readdir(join(dir, ".bearing", "runs"))).toEqual(["damaged"]);
    expect(await readFile(damagedLedgerPath)).toEqual(damagedLedger);
    expect((await stat(damagedSnapshotPath)).isDirectory()).toBe(true);

    await recordRun(durable, "blocked", "complete");
    const error = accessDenied(snapshotPath(dir, "blocked"));
    await withReadFileError(error.path!, error, async () => {
      await expect(durable.retentionPlan(
        { compactSettled: true },
        CLEANLINESS_PROOF,
      )).rejects.toBe(error);
    });
    expect(await readFile(damagedLedgerPath)).toEqual(damagedLedger);
    expect((await stat(damagedSnapshotPath)).isDirectory()).toBe(true);
  });

  it("classifies a directory at the ledger path as corrupt store structure", async () => {
    const dir = await root();
    const durable = store(dir);
    await recordRun(durable, "healthy", "complete");
    await recordRun(durable, "damaged", "complete");
    const damagedLedgerPath = ledgerPath(dir, "damaged");
    await rm(damagedLedgerPath);
    await mkdir(damagedLedgerPath);

    expect(await durable.retentionPlan(
      { compactSettled: true },
      CLEANLINESS_PROOF,
    )).toEqual([
      { runId: "healthy", action: "compact", reason: "compact_settled" },
      { runId: "damaged", action: "skip", reason: "corrupt_ledger" },
    ]);
    expect((await durable.list()).find((entry) => entry.runId === "damaged")).toMatchObject({
      unreadable: true,
      integrityError: "corrupt_ledger",
    });
    expect((await stat(damagedLedgerPath)).isDirectory()).toBe(true);
  });

  it.each([
    [
      "corrupt_ledger",
      "compaction",
      { compactSettled: true },
      { runId: "healthy", action: "compact", reason: "compact_settled" },
    ],
    [
      "corrupt_ledger",
      "pruning",
      { maxCompletedRuns: 0 },
      { runId: "healthy", action: "prune", reason: "max_completed_runs" },
    ],
    [
      "future_schema",
      "compaction",
      { compactSettled: true },
      { runId: "healthy", action: "compact", reason: "compact_settled" },
    ],
    [
      "future_schema",
      "pruning",
      { maxCompletedRuns: 0 },
      { runId: "healthy", action: "prune", reason: "max_completed_runs" },
    ],
  ] as const)("isolates a %s run while planning and applying healthy-run %s", async (
    code,
    _actionName,
    policy,
    healthyAction,
  ) => {
    const dir = await root();
    let id = 0;
    const durable = new BearingStore(dir, {
      now: () => "2026-07-19T12:00:00.000Z",
      nextEventId: () => `retention-event-${++id}`,
    });
    await recordRun(durable, "healthy", "complete");
    await recordRun(durable, "unreadable", "complete");
    const unreadablePath = ledgerPath(dir, "unreadable");
    const unreadableLedger = await makeLedgerUnreadable(dir, "unreadable", code);

    const plan = await durable.retentionPlan(policy, CLEANLINESS_PROOF);

    expect(plan).toEqual([
      healthyAction,
      { runId: "unreadable", action: "skip", reason: code },
    ]);
    expect(plan).not.toContainEqual(expect.objectContaining({
      runId: "unreadable",
      action: expect.stringMatching(/^(compact|prune)$/),
    }));
    expect(await durable.applyRetention(policy, CLEANLINESS_PROOF)).toEqual([healthyAction]);
    expect(await readFile(unreadablePath, "utf8")).toBe(unreadableLedger);
    expect(await readdir(join(dir, ".bearing", "runs"))).toContain("unreadable");
    if (healthyAction.action === "compact") {
      expect(await readFile(ledgerPath(dir, "healthy"), "utf8")).toBe("");
    } else {
      expect(await readdir(join(dir, ".bearing", "runs"))).not.toContain("healthy");
    }
  });

  it("does not prune a run that becomes unsettled after planning and before deletion", async () => {
    const dir = await root();
    let id = 0;
    class UnsettlingRetentionStore extends BearingStore {
      override async retentionPlan(
        policy?: RetentionPolicy,
        cleanlinessProof?: CallerCleanlinessProof,
      ): Promise<readonly RetentionPlanEntry[]> {
        const plan = await super.retentionPlan(policy, cleanlinessProof);
        const unsettled = await this.apply({
          ...command("settled-pending-decision", "requireDecision", 2),
          runId: "settled",
        });
        expect(unsettled.ok).toBe(true);
        return plan;
      }
    }
    const durable = new UnsettlingRetentionStore(dir, {
      now: () => "2026-07-19T12:00:00.000Z",
      nextEventId: () => `retention-event-${++id}`,
    });
    await recordRun(durable, "settled", "complete");

    expect(await durable.applyRetention({ maxCompletedRuns: 0 }, CLEANLINESS_PROOF)).toEqual([{
      runId: "settled",
      action: "prune",
      reason: "max_completed_runs",
    }]);

    expect(await durable.load("settled")).toMatchObject({
      revision: 3,
      pendingDecision: {
        decisionId: "decision-1",
        question: "Proceed?",
      },
    });
    expect(await readdir(join(dir, ".bearing", "runs"))).toContain("settled");
  });
});

describe("ledger validation", () => {
  const corruptions: Array<[
    string,
    (events: EventEnvelopeV1[], original: string) => string,
    string,
  ]> = [
    ["truncated JSONL", (_events, original) => original.slice(0, -1), "corrupt_ledger"],
    ["invalid JSON", (_events, original) => `${original}{bad}\n`, "corrupt_ledger"],
    ["event hash mismatch", (events) => `${JSON.stringify({ ...events[0], hash: "0".repeat(64) })}\n`, "event_hash_mismatch"],
    ["sequence gap", (events) => `${JSON.stringify({ ...events[0], sequence: 2 })}\n`, "sequence_mismatch"],
    ["wrong run", (events) => `${JSON.stringify({ ...events[0], runId: "other-run" })}\n`, "wrong_run_id"],
    ["future schema", (events) => `${JSON.stringify({ ...events[0], schemaVersion: 2 })}\n`, "future_schema"],
  ];

  for (const [name, mutate, code] of corruptions) {
    it(`blocks ${name} without modifying bytes`, async () => {
      const dir = await root();
      await acceptedCreate(dir);
      const path = ledgerPath(dir);
      const original = await readFile(path, "utf8");
      const events = original.trimEnd().split("\n").map((line) => JSON.parse(line) as EventEnvelopeV1);
      const corrupted = mutate(events, original);
      await writeFile(path, corrupted, "utf8");
      await expect(store(dir).load(RUN)).rejects.toMatchObject({ code });
      expect(await readFile(path, "utf8")).toBe(corrupted);
    });
  }

  it("blocks a duplicate sequence in a multi-event ledger", async () => {
    const dir = await root();
    const durable = store(dir);
    await durable.apply(command("create-1", "createWorkRequest", 0));
    await durable.apply(command("require-1", "requireDecision", 1));
    const path = ledgerPath(dir);
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    const second = JSON.parse(lines[1]) as EventEnvelopeV1;
    lines[1] = JSON.stringify({ ...second, sequence: 1 });
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");
    await expect(store(dir).load(RUN)).rejects.toMatchObject({ code: "sequence_mismatch" });
  });

  it("blocks a previous-hash mismatch", async () => {
    const dir = await root();
    const durable = store(dir);
    await durable.apply(command("create-1", "createWorkRequest", 0));
    await durable.apply(command("require-1", "requireDecision", 1));
    const path = ledgerPath(dir);
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    const second = JSON.parse(lines[1]) as EventEnvelopeV1;
    lines[1] = JSON.stringify({ ...second, previousHash: "0".repeat(64) });
    const corrupted = `${lines.join("\n")}\n`;
    await writeFile(path, corrupted, "utf8");
    await expect(store(dir).load(RUN)).rejects.toMatchObject({ code: "previous_hash_mismatch" });
    expect(await readFile(path, "utf8")).toBe(corrupted);
  });

  it("blocks a hash-valid event with a malformed type payload before replay", async () => {
    const dir = await root();
    await acceptedCreate(dir);
    const path = ledgerPath(dir);
    const [line] = (await readFile(path, "utf8")).trimEnd().split("\n");
    const event = JSON.parse(line) as EventEnvelopeV1;
    const { hash: _hash, ...body } = { ...event, payload: { title: "Title" } };
    const corrupted = `${JSON.stringify({ ...body, hash: hashEvent(body) })}\n`;
    await writeFile(path, corrupted, "utf8");
    await expect(store(dir).load(RUN)).rejects.toMatchObject({ code: "corrupt_ledger" });
  });

  it("blocks a hash-valid illegal event history", async () => {
    const dir = await root();
    await acceptedCreate(dir);
    const path = ledgerPath(dir);
    const [line] = (await readFile(path, "utf8")).trimEnd().split("\n");
    const event = JSON.parse(line) as EventEnvelopeV1;
    const { hash: _hash, ...body } = { ...event, type: "decisionRequired" as const, payload: { decisionId: "decision-1", question: "Proceed?", consequential: true } };
    const corrupted = `${JSON.stringify({ ...body, hash: hashEvent(body) })}\n`;
    await writeFile(path, corrupted, "utf8");
    await expect(store(dir).load(RUN)).rejects.toMatchObject({ code: "corrupt_ledger" });
  });

  it("throws workspace_root_changed on .bearing symlink swap during store operations", async () => {
    const dir = await root();
    const durable = store(dir);
    await acceptedCreate(dir);

    // Swap .bearing to a symlink to external dir
    const external = join(tmpdir(), `test-ext-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(external, { recursive: true });
    const bearing = join(dir, ".bearing");
    await rm(bearing, { recursive: true, force: true });
    await symlink(external, bearing);

    try {
      await expect(durable.load(RUN)).rejects.toMatchObject({ code: "workspace_root_changed" });
      await expect(durable.list()).rejects.toMatchObject({ code: "workspace_root_changed" });
      await expect(durable.retentionPlan({ maxCompletedRuns: 0 }, CLEANLINESS_PROOF)).rejects.toMatchObject({ code: "workspace_root_changed" });
      await expect(durable.delete(RUN)).rejects.toMatchObject({ code: "workspace_root_changed" });
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });
});

describe("visible per-plan workspace (issue 56)", () => {
  function boundCheckpoint(
    commandId: string,
    expectedRevision: number,
    planDirectory: string,
    status: "running" | "waiting" | "stopped" | "failed" | "complete" = "running",
  ): CommandEnvelopeV1 {
    const base = checkpointCommand(commandId, expectedRevision, status, "set-bearings");
    return {
      ...base,
      payload: { ...base.payload, planDirectory },
    } as CommandEnvelopeV1;
  }

  it("relocates a plan-bound run's audit trail into the visible per-plan workspace", async () => {
    const dir = await root();
    await acceptedCreate(dir);
    const PLAN = "docs/plans/2026-08-06-migrate-state";
    const result = await store(dir).apply(boundCheckpoint("checkpoint-1", 1, PLAN));
    expect(result.ok).toBe(true);

    const visible = join(dir, "bearing-2026-08-06-migrate-state", "runs", RUN);
    // The visible workspace holds the run's ledger and snapshot...
    expect(await readdir(visible)).toEqual(expect.arrayContaining(["events.jsonl", "snapshot.json"]));
    // ...and the run no longer hides under .bearing/runs.
    expect(await lstat(runPath(dir)).catch(() => undefined)).toBeUndefined();
  });

  it("returns the run's workspace name and audit-trail path for disclosure when a journey starts", async () => {
    const dir = await root();
    await acceptedCreate(dir);
    const PLAN = "docs/plans/2026-08-06-migrate-state";
    await store(dir).apply(boundCheckpoint("checkpoint-1", 1, PLAN));
    // The workspace field is the visible per-plan workspace; the run path is its audit trail.
    expect(await store(dir).runWorkspaceName(RUN)).toBe("bearing-2026-08-06-migrate-state");
    expect(await store(dir).runWorkspacePath(RUN))
      .toBe(`bearing-2026-08-06-migrate-state/runs/${RUN}`);
    expect(await store(dir).runWorkspaceName("never-created")).toBeUndefined();
  });

  it("keeps an unbound run fully in the legacy home, readable and resumable", async () => {
    const dir = await root();
    await acceptedCreate(dir);
    await store(dir).apply(checkpointCommand("checkpoint-1", 1, "running", "review"));

    // No plan is bound, so the run must not have migrated.
    expect(await store(dir).runWorkspacePath(RUN)).toBeUndefined();
    const legacyDir = join(dir, ".bearing", "runs", RUN);
    expect(await readdir(legacyDir)).toEqual(expect.arrayContaining(["events.jsonl", "snapshot.json"]));
    expect(await readdir(join(dir, "bearing-2026-08-06-migrate-state")).catch(() => null)).toBeNull();

    // A fresh store instance resumes the same legacy run and keeps writing there.
    const durable = store(dir);
    expect((await durable.load(RUN)).events.at(-1)?.type).toBe("journeyCheckpointRecorded");
    const resumed = await durable.apply(boundCheckpoint("checkpoint-2", 2, "docs/plans/2026-08-06-migrate-state"));
    expect(resumed.ok).toBe(true);
    expect(await durable.runWorkspacePath(RUN))
      .toBe(`bearing-2026-08-06-migrate-state/runs/${RUN}`);
    expect(await lstat(runPath(dir)).catch(() => undefined)).toBeUndefined();
  });

  it("migrates only when the ledger binds a plan, and stays put afterwards", async () => {
    const dir = await root();
    await acceptedCreate(dir);
    const PLAN = "docs/plans/2026-08-06-migrate-state";

    // A checkpoint without a plan directory leaves the run in the legacy home.
    await store(dir).apply(checkpointCommand("checkpoint-1", 1, "running", "review"));
    expect(await store(dir).runWorkspacePath(RUN)).toBeUndefined();

    // The first plan-bound checkpoint migrates the audit trail.
    const migrated = await store(dir).apply(boundCheckpoint("checkpoint-2", 2, PLAN));
    expect(migrated.ok).toBe(true);
    const visible = join(dir, "bearing-2026-08-06-migrate-state", "runs", RUN);
    expect(await readdir(visible)).toEqual(expect.arrayContaining(["events.jsonl", "snapshot.json"]));
    expect(await lstat(runPath(dir)).catch(() => undefined)).toBeUndefined();

    // Later applies on the same plan resolve the visible home and stay there.
    const settled = await store(dir).apply(boundCheckpoint("checkpoint-3", 3, PLAN, "complete"));
    expect(settled.ok).toBe(true);
    expect(await store(dir).runWorkspacePath(RUN))
      .toBe(`bearing-2026-08-06-migrate-state/runs/${RUN}`);
    expect(await lstat(runPath(dir)).catch(() => undefined)).toBeUndefined();
    expect((await store(dir).load(RUN)).events).toHaveLength(4);
  });

  it("fails closed with a typed conflict when one run exists in two homes", async () => {
    const dir = await root();
    await acceptedCreate(dir);
    const PLAN = "docs/plans/2026-08-06-migrate-state";
    await store(dir).apply(boundCheckpoint("checkpoint-1", 1, PLAN));
    expect(await lstat(runPath(dir)).catch(() => undefined)).toBeUndefined();

    // A second copy appears under the legacy home (e.g. a partial prior migration).
    await mkdir(runPath(dir), { recursive: true });

    await expect(store(dir).load(RUN)).rejects.toMatchObject({ code: "run_location_conflict" });
    await expect(store(dir).apply(boundCheckpoint("checkpoint-2", 2, PLAN)))
      .rejects.toMatchObject({ code: "run_location_conflict" });
    expect((await store(dir).list()).find((entry) => entry.runId === RUN))
      .toMatchObject({ unreadable: true, integrityError: "run_location_conflict" });
  });

  it("merges runs from both homes in list(), one home per run", async () => {
    const dir = await root();
    await acceptedCreate(dir);
    await store(dir).apply(checkpointCommand("checkpoint-1", 1, "running", "review"));
    // A second run binds a plan and lives in the visible workspace.
    await store(dir).apply({
      ...command("create-2", "createWorkRequest", 0),
      runId: "run-2",
    });
    await store(dir).apply({
      ...boundCheckpoint("checkpoint-1", 1, "docs/plans/2026-08-06-migrate-state"),
      runId: "run-2",
    });
    await store(dir).apply({
      ...boundCheckpoint("checkpoint-2", 2, "docs/plans/2026-08-06-migrate-state", "complete"),
      runId: "run-2",
    });

    const entries = await store(dir).list();
    expect(entries.map((entry) => entry.runId)).toEqual(["run-2", "run-1"]);
    expect(await store(dir).runWorkspacePath("run-1")).toBeUndefined();
    expect(await store(dir).runWorkspacePath("run-2"))
      .toBe(`bearing-2026-08-06-migrate-state/runs/run-2`);
  });

  it("degrades a refused visible-workspace migration to a durable success with a typed warning", async () => {
    const dir = await root();
    const external = await mkdtemp(join(tmpdir(), "bearing-store-external-"));
    roots.push(external);
    await acceptedCreate(dir);
    const PLAN = "docs/plans/2026-08-06-migrate-state";
    await symlink(external, join(dir, "bearing-2026-08-06-migrate-state"));

    // The checkpoint is durably committed even though the relocation was refused. Rejecting a
    // committed command would tell the caller it failed, so a retry at the same expectedRevision
    // would be refused as an illegal transition — a permanent wedge. The typed warning keeps the
    // truth (committed, durable) and the next apply retries the move.
    const result = await store(dir).apply(boundCheckpoint("checkpoint-1", 1, PLAN));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.durable).toBe(true);
      expect(result.migrationWarning).toMatchObject({
        code: "run_migration_failed",
        reason: "workspace_root_changed",
        workspace: "bearing-2026-08-06-migrate-state",
      });
    }
    // The run stays intact in its legacy home.
    expect(await readdir(runPath(dir))).toEqual(expect.arrayContaining(["events.jsonl", "snapshot.json"]));
  });

  it("leaves repo-scoped legacy state in place after a migration", async () => {
    const dir = await root();
    await acceptedCreate(dir);
    const PLAN = "docs/plans/2026-08-06-migrate-state";
    await store(dir).apply(boundCheckpoint("checkpoint-1", 1, PLAN));

    // .bearing itself and its non-run state survive the move.
    expect(await readdir(join(dir, ".bearing"))).toContain("runs");
    expect(await lstat(join(dir, ".bearing")).catch(() => undefined)).toBeDefined();
    expect(await lstat(runPath(dir)).catch(() => undefined)).toBeUndefined();
  });
});
