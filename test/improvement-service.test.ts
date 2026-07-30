import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandEnvelopeV1 } from "../src/contracts/run.js";
import {
  ImprovementService,
  type ImprovementStore,
  type ImprovementWindow,
} from "../src/improvement/improvement-service.js";
import type { MetricSnapshot } from "../src/improvement/improvement-proposal.js";
import type { OutcomeRecord } from "../src/improvement/outcome-projection.js";
import {
  BearingStore,
  BearingStoreError,
  type StoredRunState,
  type StoredRunSummary,
} from "../src/store/bearing-store.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, stat: vi.fn(original.stat) };
});

const roots: string[] = [];
const RECORDED_AT = "2026-07-26T12:00:00.000Z";
const THRESHOLDS = Object.freeze({ minSettledRuns: 20 });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bearing-improvement-service-"));
  roots.push(root);
  return root;
}

function command(
  runId: string,
  commandId: string,
  type: "createWorkRequest" | "recordJourneyCheckpoint",
  expectedRevision: number,
): CommandEnvelopeV1 {
  const base = {
    schemaVersion: 1 as const,
    commandId,
    runId,
    expectedRevision,
    correlationId: `${runId}-correlation`,
  };
  if (type === "createWorkRequest") {
    return {
      ...base,
      type,
      session: { sessionId: `${runId}-owner`, actor: "owner" },
      payload: { title: `Title ${runId}`, goal: `Goal ${runId}` },
    };
  }
  return {
    ...base,
    type,
    session: { sessionId: `${runId}-bearing`, actor: "bearing" },
    payload: {
      stage: "review",
      status: "complete",
      artifacts: [],
      lastResultJson: JSON.stringify({
        status: "action",
        summary: "Review complete.",
        artifacts: [],
        tokens: 10,
      }),
    },
  };
}

async function recordSettledRun(store: BearingStore, runId: string): Promise<void> {
  const created = await store.apply(command(runId, `${runId}-create`, "createWorkRequest", 0));
  expect(created.ok).toBe(true);
  const completed = await store.apply(command(
    runId,
    `${runId}-complete`,
    "recordJourneyCheckpoint",
    1,
  ));
  expect(completed.ok).toBe(true);
}

function digest(value: string): string {
  return createHash("sha256").update(`workspace-key\0${value}`).digest("hex");
}

function coordinationRecord(runId: string): OutcomeRecord {
  return Object.freeze({
    schemaVersion: 1,
    runRef: digest(runId),
    recordedAt: RECORDED_AT,
    signal: "coordination",
    code: "explorer",
    value: 1,
  });
}

function metric(): readonly MetricSnapshot[] {
  return Object.freeze([Object.freeze({
    id: "first-pass-success",
    value: 1,
    numerator: 1,
    denominator: 1,
    sufficient: true,
  })]);
}

async function treeSnapshot(root: string): Promise<readonly unknown[]> {
  const names = (await readdir(root, { recursive: true })).sort();
  return await Promise.all(names.map(async (name) => {
    const path = join(root, name);
    try {
      return Object.freeze({ name, contents: await readFile(path, "utf8") });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EISDIR") {
        return Object.freeze({ name, directory: true });
      }
      throw error;
    }
  }));
}

async function withStatPathSwap<T>(
  targetPath: string,
  replacementPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let swapped = false;
  const injectedStat = async (...args: Parameters<typeof stat>) => {
    const metadata = await Reflect.apply(original.stat, undefined, args);
    if (String(args[0]) === targetPath && !swapped) {
      swapped = true;
      await original.rename(replacementPath, targetPath);
    }
    return metadata;
  };
  const mockedStat = vi.mocked(stat);
  mockedStat.mockImplementation(injectedStat as typeof stat);
  try {
    return await operation();
  } finally {
    mockedStat.mockImplementation(original.stat);
  }
}

function summary(runId: string): StoredRunSummary {
  return {
    runId,
    title: `Title ${runId}`,
    goal: `Goal ${runId}`,
    updatedAt: RECORDED_AT,
  };
}

function settledState(runId: string): StoredRunState {
  return {
    runId,
    revision: 0,
    events: [],
    outcomes: new Map(),
    pendingDecision: null,
    workRequestCreated: true,
    executionRecommendation: null,
    executionApproval: null,
    journeyCheckpoint: {
      stage: "review",
      status: "complete",
      artifacts: [],
      lastResultJson: "{}",
      eventId: `${runId}-checkpoint`,
    },
  };
}

describe("improvement service", () => {
  it("snapshots the file it selected even if the path is replaced during inspection", async () => {
    const root = await temporaryRoot();
    const tree = join(root, "tree");
    const targetPath = join(tree, "entry.txt");
    const replacementPath = join(root, "replacement.txt");
    await mkdir(tree);
    await writeFile(targetPath, "original\n");
    await writeFile(replacementPath, "replacement\n");

    const snapshot = await withStatPathSwap(targetPath, replacementPath, () => treeSnapshot(tree));

    expect(snapshot).toEqual([{ name: "entry.txt", contents: "original\n" }]);
  });

  it("composes injected stages over a real store without changing the run directory", async () => {
    const root = await temporaryRoot();
    let event = 0;
    const store = new BearingStore(root, {
      now: () => RECORDED_AT,
      nextEventId: () => `event-${++event}`,
    });
    await recordSettledRun(store, "healthy-run");
    await recordSettledRun(store, "future-run");

    const futureLedger = join(root, ".bearing", "runs", "future-run", "events.jsonl");
    const lines = (await readFile(futureLedger, "utf8")).trimEnd().split("\n");
    const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    lines[0] = JSON.stringify({ ...first, schemaVersion: 2 });
    await writeFile(futureLedger, `${lines.join("\n")}\n`, "utf8");

    const before = await treeSnapshot(join(root, ".bearing", "runs"));
    const project = vi.fn((input: { readonly runId: string }) => [
      coordinationRecord(input.runId),
    ] as const);
    const measure = vi.fn((_window: ImprovementWindow) => metric());
    const recommendation = Object.freeze({
      status: "insufficient_evidence" as const,
      have: 1,
      need: 20,
      recommendations: Object.freeze([]),
    });
    const recommend = vi.fn(() => recommendation);
    const service = new ImprovementService({
      store,
      clock: () => RECORDED_AT,
      digest,
      thresholds: THRESHOLDS,
      stages: { project, measure, recommend },
      maxRuns: 10,
      maxRecords: 10,
    });

    const result = await service.report();

    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(service))).toEqual([
      "constructor",
      "report",
    ]);
    expect((service as unknown as { readonly apply?: unknown }).apply).toBeUndefined();
    expect((service as unknown as { readonly delete?: unknown }).delete).toBeUndefined();
    expect((service as unknown as { readonly clear?: unknown }).clear).toBeUndefined();
    expect(result).toBeTruthy();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value).toMatchObject({
      schemaVersion: 1,
      generatedAt: RECORDED_AT,
      listedRuns: 2,
      readableRuns: 1,
      settledRuns: 1,
      unreadableRuns: 1,
      recordsHeld: 1,
      recordsTruncated: false,
      thresholds: THRESHOLDS,
      metrics: metric(),
      recommendation,
    });
    expect(result.value.records).toEqual([coordinationRecord("healthy-run")]);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.records)).toBe(true);
    expect(project).toHaveBeenCalledTimes(1);
    expect(project).toHaveBeenCalledWith(expect.objectContaining({
      runId: "healthy-run",
      digest,
    }));
    expect(measure).toHaveBeenCalledWith(expect.objectContaining({
      generatedAt: RECORDED_AT,
      settledRuns: 1,
      records: [coordinationRecord("healthy-run")],
    }));
    expect(recommend).toHaveBeenCalledWith(expect.objectContaining({
      window: expect.objectContaining({ settledRuns: 1 }),
      metrics: metric(),
      thresholds: THRESHOLDS,
    }));
    expect(await treeSnapshot(join(root, ".bearing", "runs"))).toEqual(before);
  });

  it("counts a typed load rejection as unreadable and continues with healthy runs", async () => {
    const store: ImprovementStore = {
      list: vi.fn(async () => [summary("bad-run"), summary("healthy-run")]),
      load: vi.fn(async (runId) => {
        if (runId === "bad-run") {
          throw new BearingStoreError("future_schema", "future ledger");
        }
        return settledState(runId);
      }),
    };
    const service = new ImprovementService({
      store,
      clock: () => RECORDED_AT,
      digest,
      thresholds: THRESHOLDS,
      stages: {
        project: ({ runId }) => [coordinationRecord(runId)],
        measure: () => metric(),
        recommend: () => ({ status: "ok" as const, recommendations: [] as const }),
      },
      maxRuns: 2,
      maxRecords: 10,
    });

    const result = await service.report();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value).toMatchObject({
      listedRuns: 2,
      readableRuns: 1,
      settledRuns: 1,
      unreadableRuns: 1,
      recordsHeld: 1,
    });
    expect(result.value.records).toEqual([coordinationRecord("healthy-run")]);
  });

  it("enforces both configured bounds even when an injected store and stage over-return", async () => {
    const runs = [summary("run-1"), summary("run-2"), summary("run-3")];
    const store: ImprovementStore = {
      list: vi.fn(async () => runs),
      load: vi.fn(async (runId) => settledState(runId)),
    };
    const measure = vi.fn((_window: ImprovementWindow) => metric());
    const service = new ImprovementService({
      store,
      clock: () => RECORDED_AT,
      digest,
      thresholds: THRESHOLDS,
      stages: {
        project: ({ runId }) => [
          coordinationRecord(`${runId}-1`),
          coordinationRecord(`${runId}-2`),
        ],
        measure,
        recommend: () => ({ status: "ok" as const, recommendations: [] as const }),
      },
      maxRuns: 2,
      maxRecords: 3,
    });

    const result = await service.report();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(store.list).toHaveBeenCalledWith(2);
    expect(store.load).toHaveBeenCalledTimes(2);
    expect(result.value).toMatchObject({
      listedRuns: 2,
      readableRuns: 2,
      settledRuns: 2,
      recordsHeld: 3,
      recordsTruncated: true,
    });
    expect(result.value.records).toHaveLength(3);
    expect(measure).toHaveBeenCalledWith(expect.objectContaining({
      settledRuns: 2,
      records: result.value.records,
    }));
  });

  it("does not accept a prototype-carried unreadable marker", async () => {
    const inherited = Object.create({ unreadable: true }) as StoredRunSummary;
    Object.assign(inherited, summary("healthy-run"));
    const store: ImprovementStore = {
      list: async () => [inherited],
      load: vi.fn(async (runId) => settledState(runId)),
    };
    const service = new ImprovementService({
      store,
      clock: () => RECORDED_AT,
      digest,
      thresholds: THRESHOLDS,
      stages: {
        project: ({ runId }) => [coordinationRecord(runId)],
        measure: () => metric(),
        recommend: () => ({ status: "ok" as const, recommendations: [] as const }),
      },
    });

    const result = await service.report();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value).toMatchObject({ readableRuns: 1, unreadableRuns: 0 });
    expect(store.load).toHaveBeenCalledWith("healthy-run");
  });

  it("returns a truthy typed failure for an operational store error", async () => {
    const service = new ImprovementService({
      store: {
        list: async () => { throw new Error("offline"); },
        load: async () => settledState("unused"),
      },
      clock: () => RECORDED_AT,
      digest,
      thresholds: THRESHOLDS,
      stages: {
        project: () => [],
        measure: () => metric(),
        recommend: () => ({ status: "ok" as const, recommendations: [] as const }),
      },
    });

    const result = await service.report();

    expect(result).toEqual({ ok: false, reason: "store_read_failed" });
    expect(result).toBeTruthy();
  });
});
