import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  canonicalStringify,
  hashEvent,
  parseCommandEnvelope,
  parseEventEnvelope,
  type CommandEnvelopeV1,
  type EventEnvelopeV1,
} from "../contracts/run.js";
import {
  decide,
  initialRunState,
  replay,
  type CommandOutcome,
  type DecideFailure,
  type PendingDecision,
  type RunState,
} from "../workflow/aggregate.js";

export type FaultBoundary =
  | "before-ledger-append"
  | "after-ledger-append"
  | "before-ledger-file-sync"
  | "after-ledger-file-sync"
  | "before-ledger-parent-directory-sync"
  | "after-ledger-parent-directory-sync"
  | "before-snapshot-temp-write"
  | "after-snapshot-temp-write"
  | "before-snapshot-temp-file-sync"
  | "after-snapshot-temp-file-sync"
  | "before-snapshot-rename"
  | "after-snapshot-rename"
  | "before-snapshot-parent-directory-sync"
  | "after-snapshot-parent-directory-sync";

export type StoreErrorCode =
  | "invalid_run_id"
  | "ledger_write_failed"
  | "corrupt_ledger"
  | "future_schema"
  | "event_hash_mismatch"
  | "previous_hash_mismatch"
  | "sequence_mismatch"
  | "wrong_run_id"
  | "corrupt_snapshot";

export class BearingStoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "BearingStoreError";
  }
}

export interface BearingStoreOptions {
  readonly now?: () => string;
  readonly nextEventId?: () => string;
  readonly fault?: (boundary: FaultBoundary) => void | Promise<void>;
}

export interface SnapshotWarning {
  readonly code: "snapshot_update_failed";
  readonly boundary: FaultBoundary;
}

export interface StoredRunSummary {
  readonly runId: string;
  readonly title: string;
  readonly goal: string;
  readonly updatedAt: string;
  readonly pendingQuestion?: string;
  readonly checkpointAnswer?: string;
  readonly checkpoint?: NonNullable<RunState["journeyCheckpoint"]>;
}

export type StoreApplyResult =
  | {
      readonly ok: true;
      readonly durable: true;
      readonly state: RunState;
      readonly events: readonly EventEnvelopeV1[];
      readonly outcome: CommandOutcome;
      readonly snapshotWarning: SnapshotWarning | null;
    }
  | { readonly ok: false; readonly reason: DecideFailure; readonly state: RunState };

interface SnapshotBody {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly revision: number;
  readonly lastEventHash: string;
  readonly outcomes: readonly CommandOutcome[];
  readonly pendingDecision: PendingDecision | null;
  readonly workRequestCreated: boolean;
  readonly executionRecommendation: RunState["executionRecommendation"];
  readonly executionApproval: RunState["executionApproval"];
  readonly journeyCheckpoint?: RunState["journeyCheckpoint"];
}

interface Snapshot extends SnapshotBody {
  readonly hash: string;
}

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const queues = new Map<string, Promise<void>>();

/** Durable per-run JSONL store. `root` is the repository/workspace root. */
export class BearingStore {
  private readonly runsRoot: string;

  constructor(
    root: string,
    private readonly options: BearingStoreOptions = {},
  ) {
    this.runsRoot = resolve(root, ".bearing", "runs");
  }

  async load(runId: string): Promise<RunState> {
    this.assertRunId(runId);
    return await this.serialized(runId, () => this.loadUnlocked(runId));
  }

  async apply(command: CommandEnvelopeV1): Promise<StoreApplyResult> {
    if (typeof command?.runId === "string") this.assertRunId(command.runId);
    const parsed = parseCommandEnvelope(command);
    if (!parsed.ok) {
      const reason = parsed.reason === "future_schema" ? "future_schema" : "malformed_command";
      return { ok: false, reason, state: initialRunState("") };
    }
    return await this.serialized(parsed.value.runId, () => this.applyUnlocked(parsed.value));
  }

  async list(limit = 20): Promise<readonly StoredRunSummary[]> {
    let entries: Dirent[];
    try { entries = await readdir(this.runsRoot, { withFileTypes: true }); }
    catch (error) { if (isMissing(error)) return []; throw error; }
    const candidates = await Promise.all(entries.filter((entry) => entry.isDirectory() && RUN_ID_RE.test(entry.name)).map(async (entry) => {
      try { return { entry, modified: (await stat(join(this.runsRoot, entry.name, "events.jsonl"))).mtimeMs }; }
      catch { return { entry, modified: -1 }; }
    }));
    candidates.sort((a, b) => b.modified - a.modified || a.entry.name.localeCompare(b.entry.name));
    const summaries = await Promise.all(candidates.slice(0, 100).map(async ({ entry }) => {
      const state = await this.load(entry.name);
      const created = state.events.find((event) => event.type === "workRequestCreated");
      if (!created || typeof created.payload.title !== "string" || typeof created.payload.goal !== "string") return undefined;
      const answered = state.journeyCheckpoint?.questionDecisionId === undefined ? undefined : [...state.events].reverse().find((event) => event.type === "ownerAnswered" && event.payload.decisionId === state.journeyCheckpoint?.questionDecisionId && typeof event.payload.answer === "string");
      return { runId: entry.name, title: created.payload.title, goal: created.payload.goal, updatedAt: state.events.at(-1)?.recordedAt ?? created.recordedAt, ...(state.pendingDecision ? { pendingQuestion: state.pendingDecision.question } : {}), ...(answered ? { checkpointAnswer: answered.payload.answer as string } : {}), ...(state.journeyCheckpoint ? { checkpoint: state.journeyCheckpoint } : {}) } satisfies StoredRunSummary;
    }));
    return summaries.filter((entry): entry is StoredRunSummary => entry !== undefined).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, Math.max(0, Math.min(limit, 50)));
  }

  async delete(runId: string): Promise<void> {
    this.assertRunId(runId);
    await this.serialized(runId, () => rm(this.runDir(runId), { recursive: true, force: true }));
  }

  async clear(): Promise<void> {
    let entries: Dirent[];
    try { entries = await readdir(this.runsRoot, { withFileTypes: true }); }
    catch (error) { if (isMissing(error)) return; throw error; }
    await Promise.all(entries.filter((entry) => entry.isDirectory() && RUN_ID_RE.test(entry.name)).map((entry) => this.delete(entry.name)));
  }

  private async applyUnlocked(command: CommandEnvelopeV1): Promise<StoreApplyResult> {
    const state = await this.loadUnlocked(command.runId);
    const result = decide(state, command, {
      recordedAt: this.options.now?.() ?? new Date().toISOString(),
      nextEventId: this.options.nextEventId ?? randomUUID,
    });
    if (!result.ok || result.events.length === 0) {
      return result.ok
        ? { ...result, durable: true, snapshotWarning: null }
        : result;
    }

    const postCommitBoundary = await this.append(command.runId, result.events[0]);
    let snapshotWarning = postCommitBoundary === null ? null : warning(postCommitBoundary);
    if (snapshotWarning === null) {
      try {
        await this.writeSnapshot(command.runId, result.state);
      } catch (error) {
        snapshotWarning = warning(boundaryFrom(error));
      }
    }
    return { ...result, durable: true, snapshotWarning };
  }

  private async loadUnlocked(runId: string): Promise<RunState> {
    const events = await this.readLedger(runId);
    const snapshot = await this.readSnapshot(runId);
    if (snapshot === null) return events.length === 0 ? initialRunState(runId) : this.replayLedger(events);

    if (snapshot.runId !== runId) throw storeError("wrong_run_id", "snapshot run id mismatch");
    if (snapshot.revision > events.length) throw storeError("corrupt_snapshot", "snapshot is ahead of ledger");
    const prefixEvents = events.slice(0, snapshot.revision);
    const prefix = prefixEvents.length === 0 ? initialRunState(runId) : this.replayLedger(prefixEvents);
    if (canonicalStringify(snapshotBody(prefix)) !== canonicalStringify(withoutHash(snapshot))) {
      throw storeError("corrupt_snapshot", "snapshot projection disagrees with ledger");
    }
    return this.replayLedger(events);
  }

  private async readLedger(runId: string): Promise<EventEnvelopeV1[]> {
    const path = join(this.runDir(runId), "events.jsonl");
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    if (text.length === 0) return [];
    if (!text.endsWith("\n")) throw storeError("corrupt_ledger", "ledger has a truncated final line");

    const events: EventEnvelopeV1[] = [];
    let previousHash = "";
    for (const [index, line] of text.slice(0, -1).split("\n").entries()) {
      if (line.length === 0) throw storeError("corrupt_ledger", `ledger line ${index + 1} is empty`);
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw storeError("corrupt_ledger", `ledger line ${index + 1} is not JSON`, error);
      }
      const parsed = parseEventEnvelope(value);
      if (!parsed.ok) {
        throw storeError(
          parsed.reason === "future_schema" ? "future_schema" : "corrupt_ledger",
          `ledger line ${index + 1} has an unsupported event`,
        );
      }
      const event = parsed.value;
      if (event.runId !== runId) throw storeError("wrong_run_id", `ledger line ${index + 1} has wrong run id`);
      if (event.sequence !== index + 1) throw storeError("sequence_mismatch", `ledger line ${index + 1} has wrong sequence`);
      if (event.previousHash !== previousHash) {
        throw storeError("previous_hash_mismatch", `ledger line ${index + 1} has wrong previous hash`);
      }
      const { hash, ...body } = event;
      if (hash !== hashEvent(body)) throw storeError("event_hash_mismatch", `ledger line ${index + 1} has wrong hash`);
      previousHash = hash;
      events.push(event);
    }
    return events;
  }

  private async readSnapshot(runId: string): Promise<Snapshot | null> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(join(this.runDir(runId), "snapshot.json"), "utf8"));
    } catch (error) {
      if (isMissing(error)) return null;
      throw storeError("corrupt_snapshot", "snapshot is not JSON", error);
    }
    if (!isObject(value)) throw storeError("corrupt_snapshot", "snapshot is not an object");
    if (typeof value.schemaVersion === "number" && value.schemaVersion > 1) {
      throw storeError("future_schema", "snapshot uses a future schema");
    }
    const snapshot = value as unknown as Snapshot;
    if (!validSnapshotShape(snapshot)) throw storeError("corrupt_snapshot", "snapshot shape is invalid");
    if (snapshot.hash !== digest(canonicalStringify(withoutHash(snapshot)))) {
      throw storeError("corrupt_snapshot", "snapshot hash mismatch");
    }
    return snapshot;
  }

  private async append(runId: string, event: EventEnvelopeV1): Promise<FaultBoundary | null> {
    const dir = this.runDir(runId);
    const firstCreated = await mkdir(dir, { recursive: true });
    const file = await open(join(dir, "events.jsonl"), "a+");
    const originalSize = (await file.stat()).size;
    let boundary: FaultBoundary = "before-ledger-append";
    let durable = false;
    let failure: unknown;
    let postCommitBoundary: FaultBoundary | null = null;
    try {
      await this.inject(boundary);
      await file.appendFile(`${JSON.stringify(event)}\n`, "utf8");
      boundary = "after-ledger-append";
      await this.inject(boundary);
      boundary = "before-ledger-file-sync";
      await this.inject(boundary);
      await file.sync();
      boundary = "after-ledger-file-sync";
      await this.inject(boundary);
      boundary = "before-ledger-parent-directory-sync";
      await this.inject(boundary);
      await this.syncLedgerDirectories(dir, firstCreated);
      durable = true;
      boundary = "after-ledger-parent-directory-sync";
      await this.inject(boundary);
    } catch (error) {
      if (durable) {
        postCommitBoundary = boundary;
      } else {
        try {
          await file.truncate(originalSize);
          await file.sync();
          failure = storeError("ledger_write_failed", `ledger was not committed at ${boundary}`, error);
        } catch (rollbackError) {
          failure = storeError("ledger_write_failed", "ledger write and rollback failed", rollbackError);
        }
      }
    }
    try {
      await file.close();
    } catch (error) {
      if (durable) postCommitBoundary = boundary;
      else failure ??= storeError("ledger_write_failed", "ledger file close failed", error);
    }
    if (failure !== undefined) throw failure;
    return postCommitBoundary;
  }

  private async syncLedgerDirectories(dir: string, firstCreated: string | undefined): Promise<void> {
    const directories = [dir];
    if (firstCreated !== undefined) {
      const stop = resolve(firstCreated, "..");
      for (let current = dir; current !== stop; current = resolve(current, "..")) {
        directories.push(current);
      }
      directories.push(stop);
    }
    for (const path of new Set(directories)) {
      const handle = await open(path, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }

  private replayLedger(events: readonly EventEnvelopeV1[]): RunState {
    try {
      return replay(events);
    } catch (error) {
      throw storeError("corrupt_ledger", "ledger has an illegal event history", error);
    }
  }

  private async writeSnapshot(runId: string, state: RunState): Promise<void> {
    const dir = this.runDir(runId);
    const temp = join(dir, "snapshot.json.tmp");
    const body = snapshotBody(state);
    const bytes = `${JSON.stringify({ ...body, hash: digest(canonicalStringify(body)) })}\n`;
    let boundary: FaultBoundary = "before-snapshot-temp-write";
    try {
      await this.inject(boundary);
      const file = await open(temp, "w");
      try {
        await file.writeFile(bytes, "utf8");
        boundary = "after-snapshot-temp-write";
        await this.inject(boundary);
        boundary = "before-snapshot-temp-file-sync";
        await this.inject(boundary);
        await file.sync();
        boundary = "after-snapshot-temp-file-sync";
        await this.inject(boundary);
      } finally {
        await file.close();
      }
      boundary = "before-snapshot-rename";
      await this.inject(boundary);
      await rename(temp, join(dir, "snapshot.json"));
      boundary = "after-snapshot-rename";
      await this.inject(boundary);
      boundary = "before-snapshot-parent-directory-sync";
      await this.inject(boundary);
      const parent = await open(dir, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
      boundary = "after-snapshot-parent-directory-sync";
      await this.inject(boundary);
    } catch (error) {
      throw Object.assign(new Error("snapshot update failed", { cause: error }), { boundary });
    }
  }

  private inject(boundary: FaultBoundary): void | Promise<void> {
    return this.options.fault?.(boundary);
  }

  private runDir(runId: string): string {
    return join(this.runsRoot, runId);
  }

  private assertRunId(runId: string): void {
    if (!RUN_ID_RE.test(runId)) throw storeError("invalid_run_id", "invalid run id");
  }

  private async serialized<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const key = this.runDir(runId);
    const previous = queues.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    queues.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (queues.get(key) === tail) queues.delete(key);
    }
  }
}

function snapshotBody(state: RunState): SnapshotBody {
  return {
    schemaVersion: 1,
    runId: state.runId,
    revision: state.revision,
    lastEventHash: state.events.at(-1)?.hash ?? "",
    outcomes: [...state.outcomes.values()].sort((a, b) =>
      a.commandId < b.commandId ? -1 : a.commandId > b.commandId ? 1 : 0),
    pendingDecision: state.pendingDecision,
    workRequestCreated: state.workRequestCreated,
    executionRecommendation: state.executionRecommendation,
    executionApproval: state.executionApproval,
    ...(state.journeyCheckpoint ? { journeyCheckpoint: state.journeyCheckpoint } : {}),
  };
}

function withoutHash(snapshot: Snapshot): SnapshotBody {
  const { hash: _hash, ...body } = snapshot;
  return body;
}

function validSnapshotShape(value: Snapshot): boolean {
  return value.schemaVersion === 1 &&
    typeof value.runId === "string" &&
    Number.isSafeInteger(value.revision) && value.revision >= 0 &&
    (value.lastEventHash === "" || HASH_RE.test(value.lastEventHash)) &&
    typeof value.workRequestCreated === "boolean" &&
    (value.executionRecommendation === null || isObject(value.executionRecommendation)) &&
    (value.executionApproval === null || isObject(value.executionApproval)) &&
    (value.journeyCheckpoint === undefined || value.journeyCheckpoint === null || isObject(value.journeyCheckpoint)) &&
    (value.pendingDecision === null ||
      (isObject(value.pendingDecision) && typeof value.pendingDecision.decisionId === "string" &&
        typeof value.pendingDecision.question === "string")) &&
    Array.isArray(value.outcomes) && value.outcomes.every((outcome) =>
      isObject(outcome) && typeof outcome.commandId === "string" &&
      typeof outcome.contentHash === "string" && HASH_RE.test(outcome.contentHash) &&
      Array.isArray(outcome.eventIds) && outcome.eventIds.every((id) => typeof id === "string")) &&
    typeof value.hash === "string" && HASH_RE.test(value.hash);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function warning(boundary: FaultBoundary): SnapshotWarning {
  return { code: "snapshot_update_failed", boundary };
}

function boundaryFrom(error: unknown): FaultBoundary {
  if (isObject(error) && typeof error.boundary === "string") return error.boundary as FaultBoundary;
  return "before-snapshot-temp-write";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isObject(error) && error.code === "ENOENT";
}

function storeError(code: StoreErrorCode, message: string, cause?: unknown): BearingStoreError {
  return new BearingStoreError(code, message, cause === undefined ? undefined : { cause });
}
