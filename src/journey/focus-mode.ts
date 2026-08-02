import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { classifyWriteSetClause } from "./plan-structure.js";

const exec = promisify(execFile);
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 128;
const MAX_TEXT = 4096;
const SAFE_ID = /^(?:CMD|PROC)-[A-Z0-9][A-Z0-9.-]*$/;
const SLICE = /^###\s+Slice\s+(?<id>[A-Za-z]+\d+|\d+(?:\.\d+)+)\b.*$/gm;
const MANIFEST = /^###\s+(?<id>[A-Za-z]+\d+|\d+(?:\.\d+)+)\s+execution manifest\s*$/gmi;

export type FocusRole = "explorer" | "navigator" | "crewmate";

export interface FocusEnvelope {
  readonly version: 1;
  readonly role: FocusRole;
  readonly immutableObjective: string;
  readonly currentAcceptanceCriterion: string;
  readonly allowedPaths: readonly string[];
  readonly requiredEvidence: readonly string[];
  readonly seitCommandIds: readonly string[];
  readonly currentBlocker: string;
  readonly remainingSlices: readonly string[];
  readonly gateFailureFingerprint: string;
  readonly prohibition: "Do not perform unrelated work.";
}

export interface CommandEvidence {
  readonly commandId: string;
  readonly status: "passed" | "failed";
  readonly summary: string;
}

export interface FocusContext {
  readonly envelope: FocusEnvelope;
  readonly reviewPath: string;
  readonly reviewBefore: string;
  readonly beforeHead: string | null;
  readonly before: ReadonlyMap<string, string>;
}

export type FocusRejection =
  | "input_invalid"
  | "source_invalid"
  | "git_state"
  | "slice_structure_invalid"
  | "duplicate_slice_id"
  | "duplicate_manifest_id"
  | "slice_not_found"
  | "field_missing"
  | "field_invalid"
  | "goal_too_long"
  | "write_set_only_missing"
  | "write_set_empty"
  | "write_set_negation"
  | "write_set_conflict"
  | "write_set_path_invalid"
  | "write_set_path_duplicate"
  | "requirement_id_invalid"
  | "command_id_invalid"
  | "command_id_unmapped"
  | "contract_limit_exceeded"
  | "acceptance_missing";

type FocusFailure = {
  readonly ok: false;
  readonly reason: FocusRejection;
  readonly sliceId?: string;
  readonly field?: string;
  readonly detail?: string;
};

export type FocusContextResult =
  | { readonly ok: true; readonly value: FocusContext }
  | FocusFailure;

interface GitSnapshot {
  readonly head: string | null;
  readonly paths: ReadonlyMap<string, string>;
  readonly committedPaths: ReadonlySet<string>;
}

export type FocusCompletion =
  | { readonly ok: true; readonly changedPaths: readonly string[] }
  | { readonly ok: false; readonly reason: "git_state" | "path_outside_write_set" | "artifact_missing" | "artifact_unchanged" | "command_regressed" | "evidence_invalid" | "no_product_change" };

function boundedText(value: string, max = MAX_TEXT): boolean {
  return value.length > 0 && value.length <= max && value === value.trim() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function safePath(value: string): boolean {
  return boundedText(value) && !isAbsolute(value) && posix.normalize(value) === value && !/[*<>\\]/.test(value) && value.split("/").every((part) => part && part !== "." && part !== "..");
}

function field(section: string, name: string): string | undefined {
  const label = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\*\\*${label}\\.\\*\\*\\s*(.+)$`, "mi").exec(section)?.[1]?.trim();
}

function reject(reason: FocusRejection, context: Omit<FocusFailure, "ok" | "reason"> = {}): FocusFailure {
  return { ok: false, reason, ...context };
}

function sections(content: string, pattern: RegExp, duplicateReason: "duplicate_slice_id" | "duplicate_manifest_id"): { readonly ok: true; readonly value: Map<string, string> } | FocusFailure {
  const matches = [...content.matchAll(pattern)];
  const result = new Map<string, string>();
  for (let index = 0; index < matches.length; index += 1) {
    const id = matches[index].groups?.id;
    if (!id) return reject("slice_structure_invalid");
    if (result.has(id)) return reject(duplicateReason, { sliceId: id });
    result.set(id, content.slice(matches[index].index ?? 0, matches[index + 1]?.index ?? content.length));
  }
  return { ok: true, value: result };
}

async function source(root: string, path: string): Promise<string | undefined> {
  if (!safePath(path)) return undefined;
  const candidate = resolve(root, path);
  const relation = relative(root, candidate);
  if (!relation || relation.startsWith("..") || isAbsolute(relation)) return undefined;
  try {
    const canonical = await realpath(candidate);
    const canonicalRelation = relative(root, canonical);
    const stat = await lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SOURCE_BYTES || !canonicalRelation || canonicalRelation.startsWith("..") || isAbsolute(canonicalRelation)) return undefined;
    const content = await readFile(canonical, "utf8");
    return Buffer.byteLength(content) <= MAX_SOURCE_BYTES ? content : undefined;
  } catch {
    return undefined;
  }
}

function commandIds(value: string): string[] {
  return [...new Set([...value.matchAll(/\b(?:CMD|PROC)-[A-Z0-9][A-Z0-9.-]*\b/gi)].map((match) => match[0].toUpperCase()))];
}

function acceptance(plan: string, requirementIds: readonly string[]): string | undefined {
  for (const id of requirementIds) {
    const line = plan.split(/\r?\n/).find((candidate) => new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(candidate));
    if (line) {
      const value = line.replace(/^\s*[-*]\s*/, "").replace(/\*\*/g, "").trim();
      if (boundedText(value, 512)) return value;
    }
  }
  return requirementIds[0];
}

type ParsedContract = Omit<FocusEnvelope, "version" | "role" | "immutableObjective" | "currentBlocker" | "gateFailureFingerprint" | "prohibition">;

function parseContract(plan: string, implementation: string, seit: string, currentSlice?: string): { readonly ok: true; readonly value: ParsedContract } | FocusFailure {
  const sliceSections = sections(implementation, SLICE, "duplicate_slice_id");
  const manifests = sections(implementation, MANIFEST, "duplicate_manifest_id");
  if (!sliceSections.ok) return sliceSections;
  if (!manifests.ok) return manifests;
  if (!sliceSections.value.size || sliceSections.value.size !== manifests.value.size) return reject("slice_structure_invalid");
  if (sliceSections.value.size > MAX_ITEMS) return reject("contract_limit_exceeded", { field: "Slices" });
  if (currentSlice && (!sliceSections.value.has(currentSlice) || !manifests.value.has(currentSlice))) return reject("slice_not_found", { field: "currentSlice" });
  const selectedSlices = currentSlice ? new Map([[currentSlice, sliceSections.value.get(currentSlice)!]]) : sliceSections.value;
  const allowedPaths: string[] = [];
  const commands: string[] = [];
  const requirements: string[] = [];
  for (const [id, slice] of selectedSlices) {
    const manifest = manifests.value.get(id);
    if (!manifest) return reject("slice_structure_invalid", { sliceId: id, field: "execution manifest" });
    const goal = field(slice, "Goal");
    const requirementField = field(slice, "Requirement IDs");
    const writeSet = field(manifest, "Write set");
    const commandField = field(manifest, "Command IDs");
    if (!goal) return reject("field_missing", { sliceId: id, field: "Goal" });
    if (!requirementField) return reject("field_missing", { sliceId: id, field: "Requirement IDs" });
    if (!writeSet) return reject("field_missing", { sliceId: id, field: "Write set" });
    if (!commandField) return reject("field_missing", { sliceId: id, field: "Command IDs" });
    if (!boundedText(goal, 512)) {
      return goal.length > 512
        ? reject("goal_too_long", { sliceId: id, field: "Goal", detail: `length=${goal.length} limit=512` })
        : reject("field_invalid", { sliceId: id, field: "Goal" });
    }
    const writeSetClauseRejection = classifyWriteSetClause(writeSet);
    if (writeSetClauseRejection) {
      return reject("write_set_negation", {
        sliceId: id,
        field: "Write set",
        detail: writeSetClauseRejection.reason,
      });
    }
    const paths = [...writeSet.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    const noWrites = /\b(?:none|no writes?(?: required)?)\b/i.test(writeSet);
    if (noWrites && paths.length) return reject("write_set_conflict", { sliceId: id, field: "Write set" });
    if (!noWrites && !/\bonly\b/i.test(writeSet)) return reject("write_set_only_missing", { sliceId: id, field: "Write set" });
    if (!noWrites && !paths.length) return reject("write_set_empty", { sliceId: id, field: "Write set" });
    const unsafe = paths.find((path) => !safePath(path));
    if (unsafe) return reject("write_set_path_invalid", { sliceId: id, field: "Write set", detail: unsafe });
    const duplicate = paths.find((path, index) => paths.indexOf(path) !== index);
    if (duplicate) return reject("write_set_path_duplicate", { sliceId: id, field: "Write set", detail: duplicate });
    const requirementIds = [...requirementField.matchAll(/\b(?:AC|RISK)-[A-Z0-9][A-Z0-9.-]*\b/gi)].map((match) => match[0].toUpperCase());
    if (!requirementIds.length) return reject("requirement_id_invalid", { sliceId: id, field: "Requirement IDs" });
    const ids = commandIds(commandField);
    if (!ids.length || ids.some((command) => !SAFE_ID.test(command))) return reject("command_id_invalid", { sliceId: id, field: "Command IDs" });
    const unmapped = ids.find((command) => !new RegExp(`\\b${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(seit));
    if (unmapped) return reject("command_id_unmapped", { sliceId: id, field: "Command IDs", detail: unmapped });
    allowedPaths.push(...paths);
    commands.push(...ids);
    requirements.push(...requirementIds);
  }
  const uniquePaths = [...new Set(allowedPaths)].sort();
  const uniqueCommands = [...new Set(commands)].sort();
  if (!uniquePaths.length) return reject("write_set_empty", { field: "Write set" });
  if (uniquePaths.length > MAX_ITEMS) return reject("contract_limit_exceeded", { field: "Write set" });
  if (uniqueCommands.length > MAX_ITEMS) return reject("contract_limit_exceeded", { field: "Command IDs" });
  const criterion = acceptance(plan, requirements);
  if (!criterion) return reject("acceptance_missing", { field: "Requirement IDs" });
  return { ok: true, value: {
    currentAcceptanceCriterion: criterion,
    allowedPaths: uniquePaths,
    requiredEvidence: uniqueCommands.map((id) => `${id}: passing command evidence`),
    seitCommandIds: uniqueCommands,
    remainingSlices: [...selectedSlices.keys()],
  } };
}

async function fingerprint(root: string, path: string): Promise<string> {
  const candidate = resolve(root, path);
  try {
    const stat = await lstat(candidate);
    const hash = createHash("sha256");
    if (stat.isSymbolicLink()) hash.update(`link:${await readlink(candidate)}`);
    else if (stat.isFile()) await new Promise<void>((resolveStream, rejectStream) => {
      const stream = createReadStream(candidate);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", resolveStream);
      stream.on("error", rejectStream);
    });
    else hash.update(`type:${stat.mode}`);
    return `${stat.mode}:${stat.size}:${hash.digest("hex")}`;
  } catch {
    return "missing";
  }
}

async function gitHead(root: string): Promise<string | null | undefined> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, encoding: "utf8" });
    const value = stdout.trim();
    return /^[0-9a-f]{40,64}$/i.test(value) ? value : undefined;
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return failure.code === 128 && /needed a single revision|unknown revision|ambiguous argument 'HEAD'/i.test(failure.stderr ?? "") ? null : undefined;
  }
}

async function committedPaths(root: string, beforeHead: string | null, afterHead: string | null): Promise<ReadonlySet<string> | undefined> {
  if (beforeHead === afterHead) return new Set();
  if (beforeHead !== null && afterHead === null) return undefined;
  try {
    const args = beforeHead === null
      ? ["ls-tree", "-r", "--name-only", "-z", afterHead!]
      : ["diff", "--no-renames", "--name-only", "-z", beforeHead, afterHead!];
    const { stdout } = await exec("git", args, { cwd: root, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
    const paths = Buffer.from(stdout).toString("utf8").split("\0").filter(Boolean);
    return paths.every(safePath) ? new Set(paths) : undefined;
  } catch {
    return undefined;
  }
}

/** Snapshot Git-visible dirty paths and net committed paths from an optional baseline HEAD. */
export async function snapshotGitState(root: string, beforeHead?: string | null): Promise<GitSnapshot | undefined> {
  try {
    const canonicalRoot = await realpath(root);
    const { stdout: top } = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: canonicalRoot, encoding: "utf8" });
    if (await realpath(top.trim()) !== canonicalRoot) return undefined;
    const head = await gitHead(canonicalRoot);
    if (head === undefined) return undefined;
    const committed = beforeHead === undefined ? new Set<string>() : await committedPaths(canonicalRoot, beforeHead, head);
    if (!committed) return undefined;
    const { stdout } = await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: canonicalRoot, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
    const records = Buffer.from(stdout).toString("utf8").split("\0").filter(Boolean);
    const paths: string[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (record.length < 4) return undefined;
      const status = record.slice(0, 2);
      const path = record.slice(3);
      // Git reports an empty untracked directory as `dir/` (trailing slash); it holds no
      // content to snapshot, so skip it rather than failing the whole snapshot closed.
      if (status === "??" && path.endsWith("/")) continue;
      if (!safePath(path)) return undefined;
      if (!(status === "??" && path.startsWith(".bearing/"))) paths.push(path);
      if (/[RC]/.test(status)) {
        const prior = records[++index];
        if (!prior || !safePath(prior)) return undefined;
        paths.push(prior);
      }
    }
    const unique = [...new Set([...paths, ...committed])].sort();
    return {
      head,
      paths: new Map(await Promise.all(unique.map(async (path) => [path, await fingerprint(canonicalRoot, path)] as const))),
      committedPaths: committed,
    };
  } catch {
    return undefined;
  }
}

export async function createFocusContext(input: {
  readonly root: string;
  readonly planDirectory: string;
  readonly role: FocusRole;
  readonly objective: string;
  readonly currentBlocker?: string;
  readonly gateFailureFingerprint?: string;
  readonly currentSlice?: string;
}): Promise<FocusContextResult> {
  if (!safePath(input.planDirectory)) return reject("input_invalid", { field: "planDirectory" });
  if (!boundedText(input.objective)) return reject("input_invalid", { field: "objective" });
  const planPath = posix.join(input.planDirectory, "plan-spec.md");
  const implementationPath = posix.join(input.planDirectory, "implementation.md");
  const seitPath = posix.join(input.planDirectory, "seit.md");
  const [plan, implementation, seit, snapshot] = await Promise.all([
    source(input.root, planPath), source(input.root, implementationPath), source(input.root, seitPath), snapshotGitState(input.root),
  ]);
  if (!plan) return reject("source_invalid", { field: "plan-spec.md" });
  if (!implementation) return reject("source_invalid", { field: "implementation.md" });
  if (!seit) return reject("source_invalid", { field: "seit.md" });
  if (!snapshot) return reject("git_state");
  const contract = parseContract(plan, implementation, seit, input.currentSlice);
  const blocker = input.currentBlocker ?? "none";
  const gate = input.gateFailureFingerprint ?? "none";
  if (!contract.ok) return contract;
  if (!boundedText(blocker)) return reject("input_invalid", { field: "currentBlocker" });
  if (!boundedText(gate, 512)) return reject("input_invalid", { field: "gateFailureFingerprint" });
  const reviewPath = posix.join(input.planDirectory, "review.html");
  const reviewBefore = await fingerprint(input.root, reviewPath);
  return { ok: true, value: {
    envelope: {
      version: 1,
      role: input.role,
      immutableObjective: input.objective,
      ...contract.value,
      allowedPaths: [...new Set([...contract.value.allowedPaths, reviewPath])].sort(),
      currentBlocker: blocker,
      gateFailureFingerprint: gate,
      prohibition: "Do not perform unrelated work.",
    },
    reviewPath,
    reviewBefore,
    beforeHead: snapshot.head,
    before: snapshot.paths,
  } };
}

function validEvidence(required: readonly string[], evidence: readonly CommandEvidence[]): boolean {
  if (evidence.length !== required.length || evidence.length > MAX_ITEMS) return false;
  const seen = new Set<string>();
  for (const item of evidence) {
    if (!item || typeof item !== "object" || !SAFE_ID.test(item.commandId) || seen.has(item.commandId) || item.status !== "passed" || !boundedText(item.summary, 512)) return false;
    seen.add(item.commandId);
  }
  return required.every((id) => seen.has(id));
}

export async function validateFocusCompletion(context: FocusContext, root: string, artifacts: readonly string[], evidence: readonly CommandEvidence[]): Promise<FocusCompletion> {
  const [after, reviewAfter] = await Promise.all([
    snapshotGitState(root, context.beforeHead),
    fingerprint(root, context.reviewPath),
  ]);
  if (!after) return { ok: false, reason: "git_state" };
  if (after.head !== context.beforeHead && after.committedPaths.size === 0) return { ok: false, reason: "git_state" };
  const changed = [...new Set([
    ...[...new Set([...context.before.keys(), ...after.paths.keys(), ...after.committedPaths])]
      .filter((path) => after.committedPaths.has(path) || context.before.get(path) !== after.paths.get(path)),
    ...(reviewAfter !== context.reviewBefore ? [context.reviewPath] : []),
  ])].sort();
  const allowed = new Set([...context.envelope.allowedPaths, context.reviewPath]);
  if (artifacts.some((path) => !allowed.has(path))) return { ok: false, reason: "path_outside_write_set" };
  if (changed.some((path) => !allowed.has(path))) return { ok: false, reason: "path_outside_write_set" };
  if (changed.some((path) => !artifacts.includes(path))) return { ok: false, reason: "artifact_missing" };
  // The receipt's artifact list and the paths that actually changed must be the SAME set, not merely
  // overlapping. Enforcing only `changed ⊆ artifacts` lets an agent declare a production file it never
  // touched: declare src/thing.ts plus its test, change only the test, and every other check still
  // passes — there is a product change, and nothing changed outside the write set. That is the exact
  // shape of a fabricated fix, and it is the failure this boundary exists to refuse.
  if (artifacts.some((path) => !changed.includes(path))) return { ok: false, reason: "artifact_unchanged" };
  // A declared command that ran and FAILED is a regression signal, not a gap in the evidence. Folding
  // both into evidence_invalid gave a broken build the same soft verdict as a missing summary, so the
  // one outcome that means "previously-working behaviour stopped working" was the easiest to overlook.
  if (evidence.some((item) => item && typeof item === "object" && SAFE_ID.test(item.commandId) && item.status === "failed")) {
    return { ok: false, reason: "command_regressed" };
  }
  if (!validEvidence(context.envelope.seitCommandIds, evidence)) return { ok: false, reason: "evidence_invalid" };
  if (!changed.some((path) => path !== context.reviewPath)) return { ok: false, reason: "no_product_change" };
  return { ok: true, changedPaths: changed };
}
