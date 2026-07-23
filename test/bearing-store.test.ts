import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { hashEvent, parseEventEnvelope, type CommandEnvelopeV1, type EventEnvelopeV1 } from "../src/contracts/run.js";
import {
  BearingStore,
  type FaultBoundary,
} from "../src/store/bearing-store.js";
import { replay } from "../src/workflow/aggregate.js";

const roots: string[] = [];
const RUN = "run-1";
const SESSION = { sessionId: "session-1", actor: "owner" };

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
    return { ...base, type, payload: payload ?? { title: "Title", goal: "Goal" } } as CommandEnvelopeV1;
  }
  if (type === "requireDecision") {
    return {
      ...base,
      type,
      payload: payload ?? { decisionId: "decision-1", question: "Proceed?", consequential: true },
    } as CommandEnvelopeV1;
  }
  return {
    ...base,
    type,
    payload: payload ?? { decisionId: "decision-1", answer: "Yes" },
  } as CommandEnvelopeV1;
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

function ledgerPath(rootDir: string): string {
  return join(rootDir, ".bearing", "runs", RUN, "events.jsonl");
}

function snapshotPath(rootDir: string): string {
  return join(rootDir, ".bearing", "runs", RUN, "snapshot.json");
}

async function acceptedCreate(rootDir: string): Promise<void> {
  const result = await store(rootDir).apply(command("create-1", "createWorkRequest", 0));
  expect(result.ok).toBe(true);
}

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
});
