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
  | "corrupt_snapshot"
  | "run_not_settled"
  | "run_compacted";

const STORE_INTEGRITY_ERROR_CODE_LIST = [
  "corrupt_ledger",
  "future_schema",
  "event_hash_mismatch",
  "previous_hash_mismatch",
  "sequence_mismatch",
  "wrong_run_id",
  "corrupt_snapshot",
] as const satisfies readonly StoreErrorCode[];

const STORE_INTEGRITY_ERROR_CODES = new Set<StoreErrorCode>(STORE_INTEGRITY_ERROR_CODE_LIST);

const MALFORMED_REQUIRED_FILE_ERROR_CODES = new Set([
  "EISDIR",
  "ENOTDIR",
  "ELOOP",
  "EFTYPE",
]);

export type StoreIntegrityErrorCode = (typeof STORE_INTEGRITY_ERROR_CODE_LIST)[number];

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

export function isStoreIntegrityError(
  error: unknown,
): error is BearingStoreError & { readonly code: StoreIntegrityErrorCode } {
  return error instanceof BearingStoreError && STORE_INTEGRITY_ERROR_CODES.has(error.code);
}

export interface BearingStoreOptions {
  readonly now?: () => string;
  readonly nextEventId?: () => string;
  readonly fault?: (boundary: FaultBoundary) => void | Promise<void>;
}

/** Live, caller-owned facts that the event-sourced store cannot prove or persist safely. */
export interface CallerCleanlinessProof {
  readonly noDirtyOrUnmergedLane: true;
  readonly runNotBusy: true;
}

export interface RetentionPolicy {
  readonly maxAgeDays?: number;
  readonly maxCompletedRuns?: number;
  readonly compactSettled?: boolean;
}

export type RetentionReason = "max_age_days" | "max_completed_runs" | "compact_settled";

export type RetentionPlanEntry =
  | {
      readonly runId: string;
      readonly action: "compact" | "prune";
      readonly reason: RetentionReason;
    }
  | {
      readonly runId: string;
      readonly action: "skip";
      readonly reason: StoreIntegrityErrorCode;
    };

type RetentionAction = Exclude<RetentionPlanEntry, { readonly action: "skip" }>;
type RetentionSkip = Extract<RetentionPlanEntry, { readonly action: "skip" }>;

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

export interface UnreadableStoredRunSummary {
  readonly runId: string;
  readonly title: string;
  readonly goal: string;
  readonly updatedAt: string;
  readonly unreadable: true;
  readonly integrityError: StoreIntegrityErrorCode;
  readonly pendingQuestion?: never;
  readonly checkpointAnswer?: never;
  readonly checkpoint?: never;
}

export type StoredRunListEntry = StoredRunSummary | UnreadableStoredRunSummary;

export interface CompactedRunSummary {
  readonly title: string;
  readonly goal: string;
  readonly updatedAt: string;
}

export interface CompactedRunState extends RunState {
  readonly sealed: true;
  readonly summary: CompactedRunSummary;
}

export type StoredRunState = RunState | CompactedRunState;

interface RetentionRun {
  readonly runId: string;
  readonly state: StoredRunState;
  readonly updatedAt: string;
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
  readonly compacted?: {
    readonly atSequence: number;
    readonly atEventHash: string;
    readonly compactedAt: string;
  };
  readonly summary?: CompactedRunSummary;
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

  async load(runId: string): Promise<StoredRunState> {
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

  async compact(
    runId: string,
    cleanlinessProof?: CallerCleanlinessProof,
  ): Promise<CompactedRunState> {
    this.assertRunId(runId);
    assertCallerCleanlinessProof(cleanlinessProof);
    return await this.serialized(runId, () => this.compactUnlocked(runId, cleanlinessProof));
  }

  async retentionPlan(
    policy?: RetentionPolicy,
    cleanlinessProof?: CallerCleanlinessProof,
  ): Promise<readonly RetentionPlanEntry[]> {
    if (!hasEffectiveRetentionPolicy(policy)) return [];
    assertRetentionPolicy(policy);
    assertCallerCleanlinessProof(cleanlinessProof);

    let entries: Dirent[];
    try { entries = await readdir(this.runsRoot, { withFileTypes: true }); }
    catch (error) { if (isMissing(error)) return []; throw error; }
    const candidates = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && RUN_ID_RE.test(entry.name))
      .map(async (entry) => {
        let state: StoredRunState;
        try {
          state = await this.load(entry.name);
        } catch (error) {
          if (isStoreIntegrityError(error)) {
            return {
              runId: entry.name,
              action: "skip",
              reason: error.code,
            } satisfies RetentionSkip;
          }
          throw error;
        }
        if (!isSettled(state, cleanlinessProof)) return undefined;
        return {
          runId: entry.name,
          state,
          updatedAt: retentionUpdatedAt(state),
        };
      }));
    const completed = candidates
      .filter((entry): entry is RetentionRun => entry !== undefined && !("action" in entry))
      .sort(compareRetentionRuns);
    const skipped = candidates
      .filter((entry): entry is RetentionSkip => entry !== undefined && "action" in entry)
      .sort((a, b) => a.runId.localeCompare(b.runId));

    const pruneReasons = new Map<string, RetentionReason>();
    if (policy.maxAgeDays !== undefined) {
      const now = Date.parse(this.options.now?.() ?? new Date().toISOString());
      if (!Number.isFinite(now)) throw new RangeError("store clock returned an invalid timestamp");
      const cutoff = now - policy.maxAgeDays * 24 * 60 * 60 * 1_000;
      for (const run of completed) {
        if (retentionTimestamp(run) <= cutoff) pruneReasons.set(run.runId, "max_age_days");
      }
    }
    if (policy.maxCompletedRuns !== undefined) {
      const retained = completed
        .filter((run) => !pruneReasons.has(run.runId))
        .sort((a, b) => compareRetentionRuns(b, a))
        .slice(policy.maxCompletedRuns);
      for (const run of retained) pruneReasons.set(run.runId, "max_completed_runs");
    }

    return [
      ...completed.flatMap((run): RetentionAction[] => {
        const pruneReason = pruneReasons.get(run.runId);
        if (pruneReason !== undefined) {
          return [{ runId: run.runId, action: "prune", reason: pruneReason }];
        }
        if (policy.compactSettled === true && !isCompactedRunState(run.state)) {
          return [{ runId: run.runId, action: "compact", reason: "compact_settled" }];
        }
        return [];
      }),
      ...skipped,
    ];
  }

  async applyRetention(
    policy?: RetentionPolicy,
    cleanlinessProof?: CallerCleanlinessProof,
  ): Promise<readonly RetentionPlanEntry[]> {
    const plan = await this.retentionPlan(policy, cleanlinessProof);
    const actions = plan.filter((entry): entry is RetentionAction => entry.action !== "skip");
    for (const entry of actions) {
      if (entry.action === "compact") await this.compact(entry.runId, cleanlinessProof);
      else {
        await this.serialized(entry.runId, async () => {
          const state = await this.loadUnlocked(entry.runId);
          if (isSettled(state, cleanlinessProof)) await this.deleteUnlocked(entry.runId);
        });
      }
    }
    return actions;
  }

  async list(limit = 20): Promise<readonly StoredRunListEntry[]> {
    let entries: Dirent[];
    try { entries = await readdir(this.runsRoot, { withFileTypes: true }); }
    catch (error) { if (isMissing(error)) return []; throw error; }
    const candidates = await Promise.all(entries.filter((entry) => entry.isDirectory() && RUN_ID_RE.test(entry.name)).map(async (entry) => {
      const dir = join(this.runsRoot, entry.name);
      try {
        const ledger = await stat(join(dir, "events.jsonl"));
        if (ledger.size > 0) return { entry, modified: ledger.mtimeMs };
      } catch { /* A missing ledger is valid only for a compacted snapshot. */ }
      try { return { entry, modified: (await stat(join(dir, "snapshot.json"))).mtimeMs }; }
      catch { return { entry, modified: -1 }; }
    }));
    candidates.sort((a, b) => b.modified - a.modified || a.entry.name.localeCompare(b.entry.name));
    const summaries = await Promise.all(candidates.slice(0, 100).map(async ({ entry, modified }) => {
      let state: StoredRunState;
      try {
        state = await this.load(entry.name);
      } catch (error) {
        if (!isStoreIntegrityError(error)) throw error;
        return {
          runId: entry.name,
          title: `Unreadable run: ${entry.name}`,
          goal: `Integrity check failed (${error.code}). Bearing left this run untouched.`,
          updatedAt: new Date(modified).toISOString(),
          unreadable: true,
          integrityError: error.code,
        } satisfies UnreadableStoredRunSummary;
      }
      if (isCompactedRunState(state)) {
        return {
          runId: entry.name,
          ...state.summary,
          ...(state.journeyCheckpoint ? { checkpoint: state.journeyCheckpoint } : {}),
        } satisfies StoredRunSummary;
      }
      const created = state.events.find((event) => event.type === "workRequestCreated");
      if (!created || typeof created.payload.title !== "string" || typeof created.payload.goal !== "string") return undefined;
      const answered = state.journeyCheckpoint?.questionDecisionId === undefined ? undefined : [...state.events].reverse().find((event) => event.type === "ownerAnswered" && event.payload.decisionId === state.journeyCheckpoint?.questionDecisionId && typeof event.payload.answer === "string");
      return { runId: entry.name, title: created.payload.title, goal: created.payload.goal, updatedAt: state.events.at(-1)?.recordedAt ?? created.recordedAt, ...(state.pendingDecision ? { pendingQuestion: state.pendingDecision.question } : {}), ...(answered ? { checkpointAnswer: answered.payload.answer as string } : {}), ...(state.journeyCheckpoint ? { checkpoint: state.journeyCheckpoint } : {}) } satisfies StoredRunSummary;
    }));
    return summaries.filter((entry): entry is StoredRunListEntry => entry !== undefined).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, Math.max(0, Math.min(limit, 50)));
  }

  async delete(runId: string): Promise<void> {
    this.assertRunId(runId);
    await this.serialized(runId, () => this.deleteUnlocked(runId));
  }

  async clear(): Promise<void> {
    let entries: Dirent[];
    try { entries = await readdir(this.runsRoot, { withFileTypes: true }); }
    catch (error) { if (isMissing(error)) return; throw error; }
    await Promise.all(entries.filter((entry) => entry.isDirectory() && RUN_ID_RE.test(entry.name)).map((entry) => this.delete(entry.name)));
  }

  private async applyUnlocked(command: CommandEnvelopeV1): Promise<StoreApplyResult> {
    const state = await this.loadUnlocked(command.runId);
    if (isCompactedRunState(state)) throw storeError("run_compacted", "compacted runs are sealed");
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

  private async compactUnlocked(
    runId: string,
    cleanlinessProof: CallerCleanlinessProof,
  ): Promise<CompactedRunState> {
    const events = await this.readLedger(runId);
    let snapshot = await this.readSnapshot(runId);
    if (snapshot !== null && snapshot.runId !== runId) {
      throw storeError("wrong_run_id", "snapshot run id mismatch");
    }

    if (snapshot?.compacted !== undefined) {
      const sealed = this.loadCompactedSnapshot(snapshot, events);
      if (!isSettled(sealed, cleanlinessProof)) {
        throw storeError("run_not_settled", "run is not proven settled");
      }
      if (events.length > 0) await this.truncateLedger(runId);
      return sealed;
    }

    if (snapshot !== null) {
      if (snapshot.revision > events.length) {
        throw storeError("corrupt_snapshot", "snapshot is ahead of ledger");
      }
      const prefixEvents = events.slice(0, snapshot.revision);
      const prefix = prefixEvents.length === 0 ? initialRunState(runId) : this.replayLedger(prefixEvents);
      this.verifySnapshotProjection(snapshot, prefix);
    }

    const replayed = this.replayLedger(events);
    if (!isSettled(replayed, cleanlinessProof)) {
      throw storeError("run_not_settled", "run is not proven settled");
    }

    if (snapshot === null || snapshot.revision !== events.length) {
      await this.writeSnapshot(runId, replayed);
      snapshot = await this.readSnapshot(runId);
      if (snapshot === null || snapshot.compacted !== undefined || snapshot.revision !== events.length) {
        throw storeError("corrupt_snapshot", "current snapshot regeneration failed");
      }
      if (snapshot.runId !== runId) {
        throw storeError("wrong_run_id", "snapshot run id mismatch");
      }
    }
    this.verifySnapshotProjection(snapshot, replayed);
    const created = events.find((event) => event.type === "workRequestCreated");
    const last = events.at(-1);
    if (!created || !last || typeof created.payload.title !== "string" || typeof created.payload.goal !== "string") {
      throw storeError("corrupt_ledger", "settled run is missing its work request summary");
    }

    const compactedBody: SnapshotBody = {
      ...snapshotBody(replayed),
      compacted: {
        atSequence: events.length,
        atEventHash: last.hash,
        compactedAt: this.options.now?.() ?? new Date().toISOString(),
      },
      summary: {
        title: created.payload.title,
        goal: created.payload.goal,
        updatedAt: last.recordedAt,
      },
    };
    await this.writeSnapshotBody(runId, compactedBody);

    const written = await this.readSnapshot(runId);
    if (written === null || canonicalStringify(withoutHash(written)) !== canonicalStringify(compactedBody)) {
      throw storeError("corrupt_snapshot", "compacted snapshot verification failed");
    }
    const sealed = stateFromCompactedSnapshot(written);
    await this.truncateLedger(runId);
    return sealed;
  }

  private async loadUnlocked(runId: string): Promise<StoredRunState> {
    const events = await this.readLedger(runId);
    const snapshot = await this.readSnapshot(runId);
    if (snapshot === null) return events.length === 0 ? initialRunState(runId) : this.replayLedger(events);

    if (snapshot.runId !== runId) throw storeError("wrong_run_id", "snapshot run id mismatch");
    if (snapshot.compacted !== undefined) return this.loadCompactedSnapshot(snapshot, events);
    if (snapshot.revision > events.length) throw storeError("corrupt_snapshot", "snapshot is ahead of ledger");
    const prefixEvents = events.slice(0, snapshot.revision);
    const prefix = prefixEvents.length === 0 ? initialRunState(runId) : this.replayLedger(prefixEvents);
    if (canonicalStringify(snapshotBody(prefix)) !== canonicalStringify(withoutHash(snapshot))) {
      throw storeError("corrupt_snapshot", "snapshot projection disagrees with ledger");
    }
    return this.replayLedger(events);
  }

  private loadCompactedSnapshot(snapshot: Snapshot, events: readonly EventEnvelopeV1[]): CompactedRunState {
    if (events.length !== 0 && events.length !== snapshot.revision) {
      throw storeError("corrupt_snapshot", "compacted snapshot has an incomplete ledger tail");
    }
    if (events.length > 0) this.verifySnapshotProjection(snapshot, this.replayLedger(events));
    return stateFromCompactedSnapshot(snapshot);
  }

  private verifySnapshotProjection(snapshot: Snapshot, state: RunState): void {
    if (canonicalStringify(snapshotBody(state)) !== canonicalStringify(snapshotProjectionBody(snapshot))) {
      throw storeError("corrupt_snapshot", "snapshot projection disagrees with ledger");
    }
  }

  private async readLedger(runId: string): Promise<EventEnvelopeV1[]> {
    const path = join(this.runDir(runId), "events.jsonl");
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isMissing(error)) return [];
      if (isMalformedRequiredFile(error)) {
        throw storeError("corrupt_ledger", "ledger path is not a readable file", error);
      }
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
    let text: string;
    try {
      text = await readFile(join(this.runDir(runId), "snapshot.json"), "utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      if (isMalformedRequiredFile(error)) {
        throw storeError("corrupt_snapshot", "snapshot path is not a readable file", error);
      }
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
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

  private async truncateLedger(runId: string): Promise<void> {
    const file = await open(join(this.runDir(runId), "events.jsonl"), "r+");
    try {
      await file.truncate(0);
      await file.sync();
    } finally {
      await file.close();
    }
  }

  private async deleteUnlocked(runId: string): Promise<void> {
    await rm(this.runDir(runId), { recursive: true, force: true });
  }

  private replayLedger(events: readonly EventEnvelopeV1[]): RunState {
    try {
      return replay(events);
    } catch (error) {
      throw storeError("corrupt_ledger", "ledger has an illegal event history", error);
    }
  }

  private async writeSnapshot(runId: string, state: RunState): Promise<void> {
    await this.writeSnapshotBody(runId, snapshotBody(state));
  }

  private async writeSnapshotBody(runId: string, body: SnapshotBody): Promise<void> {
    const dir = this.runDir(runId);
    const temp = join(dir, "snapshot.json.tmp");
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

function snapshotProjectionBody(snapshot: Snapshot): SnapshotBody {
  const { hash: _hash, compacted: _compacted, summary: _summary, ...body } = snapshot;
  return body;
}

function withoutHash(snapshot: Snapshot): SnapshotBody {
  const { hash: _hash, ...body } = snapshot;
  return body;
}

function stateFromSnapshot(snapshot: Snapshot): RunState {
  return Object.assign(initialRunState(snapshot.runId), {
    revision: snapshot.revision,
    events: [] as readonly EventEnvelopeV1[],
    outcomes: new Map(snapshot.outcomes.map((outcome) => [outcome.commandId, outcome])),
    pendingDecision: snapshot.pendingDecision,
    workRequestCreated: snapshot.workRequestCreated,
    executionRecommendation: snapshot.executionRecommendation,
    executionApproval: snapshot.executionApproval,
    journeyCheckpoint: snapshot.journeyCheckpoint ?? null,
  });
}

function stateFromCompactedSnapshot(snapshot: Snapshot): CompactedRunState {
  if (snapshot.compacted === undefined || snapshot.summary === undefined) {
    throw storeError("corrupt_snapshot", "compacted snapshot is missing terminal metadata");
  }
  return Object.assign(stateFromSnapshot(snapshot), {
    sealed: true as const,
    summary: snapshot.summary,
  });
}

export function isCompactedRunState(state: StoredRunState): state is CompactedRunState {
  return "sealed" in state && state.sealed === true;
}

/**
 * Shared settle proof for compaction and retention.
 *
 * The store proves the event-sourced conditions itself: the final review checkpoint is complete
 * and no owner decision is pending. It trusts the caller for exactly the two transient conditions
 * that cannot safely live in the append-only ledger: there is no dirty or unmerged lane, and the
 * run is not busy. Missing or incomplete caller proof fails closed.
 */
function isSettled(state: RunState, cleanlinessProof?: CallerCleanlinessProof): boolean {
  const checkpoint = state.journeyCheckpoint;
  return hasCallerCleanlinessProof(cleanlinessProof) &&
    state.pendingDecision === null &&
    checkpoint !== null &&
    checkpoint.stage === "review" &&
    checkpoint.status === "complete";
}

function hasCallerCleanlinessProof(
  proof: CallerCleanlinessProof | undefined,
): proof is CallerCleanlinessProof {
  return proof?.noDirtyOrUnmergedLane === true && proof.runNotBusy === true;
}

function assertCallerCleanlinessProof(
  proof: CallerCleanlinessProof | undefined,
): asserts proof is CallerCleanlinessProof {
  if (!hasCallerCleanlinessProof(proof)) {
    throw storeError("run_not_settled", "caller cleanliness proof is required");
  }
}

function hasEffectiveRetentionPolicy(policy: RetentionPolicy | undefined): policy is RetentionPolicy {
  return policy !== undefined &&
    (policy.maxAgeDays !== undefined ||
      policy.maxCompletedRuns !== undefined ||
      policy.compactSettled === true);
}

function assertRetentionPolicy(policy: RetentionPolicy): void {
  if (policy.maxAgeDays !== undefined &&
    (!Number.isFinite(policy.maxAgeDays) || policy.maxAgeDays < 0)) {
    throw new RangeError("maxAgeDays must be a non-negative finite number");
  }
  if (policy.maxCompletedRuns !== undefined &&
    (!Number.isSafeInteger(policy.maxCompletedRuns) || policy.maxCompletedRuns < 0)) {
    throw new RangeError("maxCompletedRuns must be a non-negative safe integer");
  }
}

function retentionUpdatedAt(state: StoredRunState): string {
  if (isCompactedRunState(state)) return state.summary.updatedAt;
  const updatedAt = state.events.at(-1)?.recordedAt;
  if (updatedAt === undefined) {
    throw storeError("corrupt_ledger", "settled run is missing its final event timestamp");
  }
  return updatedAt;
}

function retentionTimestamp(run: RetentionRun): number {
  const timestamp = Date.parse(run.updatedAt);
  if (!Number.isFinite(timestamp)) {
    throw storeError("corrupt_snapshot", `run ${run.runId} has an invalid retention timestamp`);
  }
  return timestamp;
}

function compareRetentionRuns(a: RetentionRun, b: RetentionRun): number {
  return retentionTimestamp(a) - retentionTimestamp(b) || a.runId.localeCompare(b.runId);
}

function validSnapshotShape(value: Snapshot): boolean {
  const terminal = value.compacted === undefined && value.summary === undefined ||
    isObject(value.compacted) && Object.keys(value.compacted).length === 3 &&
    Number.isSafeInteger(value.compacted.atSequence) && value.compacted.atSequence > 0 &&
    typeof value.compacted.atEventHash === "string" && HASH_RE.test(value.compacted.atEventHash) &&
    typeof value.compacted.compactedAt === "string" && value.compacted.compactedAt.length > 0 &&
    isObject(value.summary) && Object.keys(value.summary).length === 3 &&
    typeof value.summary.title === "string" && value.summary.title.length > 0 &&
    typeof value.summary.goal === "string" && value.summary.goal.length > 0 &&
    typeof value.summary.updatedAt === "string" && value.summary.updatedAt.length > 0 &&
    value.compacted.atSequence === value.revision &&
    value.compacted.atEventHash === value.lastEventHash;
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
    terminal &&
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

function isMalformedRequiredFile(error: unknown): boolean {
  return isObject(error)
    && typeof error.code === "string"
    && MALFORMED_REQUIRED_FILE_ERROR_CODES.has(error.code);
}

function storeError(code: StoreErrorCode, message: string, cause?: unknown): BearingStoreError {
  return new BearingStoreError(code, message, cause === undefined ? undefined : { cause });
}
