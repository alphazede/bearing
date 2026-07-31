#!/usr/bin/env node
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NodeProcessRunner } from "./adapters/process-runner.js";
import {
  exportContributionBundle,
  type ContributionBundle,
  type ContributionPolicyValue,
  type ExportContributionResult,
} from "./improvement/improvement-export.js";
import {
  type MetricCollection,
  type MetricValue,
  type PolicyValue,
  type Recommendation,
  type RecommendationResult,
  type Thresholds,
} from "./improvement/improvement-recommender.js";
import type { MetricSet } from "./improvement/improvement-metrics.js";
import {
  type ImprovementServiceFailure,
} from "./improvement/improvement-service.js";
import type { TrialVerdict } from "./improvement/improvement-proposal.js";
import { planDirectoryValid } from "./journey/plan-directory.js";
import { validatePlan } from "./journey/planning-validator.js";
import type { PlanDocuments } from "./journey/plan-structure.js";
import { REASONING_TIERS } from "./profile/reasoning-policy.js";
import { normalizeReasoningTier, type RunOverrides } from "./profile/profile.js";
import { beginStandaloneFocus, validateStandaloneFocus, type StandaloneFocusBegin } from "./journey/standalone-focus.js";
import {
  workspaceCompact,
  workspaceDoctor,
  workspacePrune,
  workspaceStatus,
  type WorkspaceToolsDeps,
} from "./repository/workspace-tools.js";
import { BearingStore, type RetentionPolicy } from "./store/bearing-store.js";
import {
  LocalSessionService,
  buildImprovementReport,
  buildImprovementHandoffFacts,
  createRequestHandler,
  executeHeadlessJourney,
  renderImprovementHandoff,
  type HeadlessJourneyReceipt,
  type HeadlessJourneyRequest,
} from "./server/local-session.js";
import { RECORD_JOURNEY_CHECKPOINT_STAGES } from "./contracts/run.js";

const REASONING_VALUES = [...REASONING_TIERS, "default", "off", "none", "xhigh", "ultra", "thinking"] as const;
const USAGE = [
  "usage: bearing start [--detach] [--no-open] [safe shared overrides]",
  `       --reasoning accepted values: ${REASONING_VALUES.join(", ")}`,
  "       bearing focus begin --request <relative-json>",
  "       bearing focus validate --run <opaque-run-id> --receipt <relative-json>",
  "       bearing journey create --repo <abs> --provider <id> --model <id> --reasoning <level> --run <id> --goal <text>",
  "       bearing journey (resume|status|approve-route|confirm-amendment) --repo <abs> --provider <id> --model <id> --reasoning <level> --run <id>",
  "       bearing journey decide --repo <abs> --provider <id> --model <id> --reasoning <level> --run <id> --answer <text>",
  "       bearing journey select-execution --repo <abs> --provider <id> --model <id> --reasoning <level> --run <id> --mode <explorer|expedition> --review-cadence <slice|phase|end>",
  "       bearing journey select-explorer --repo <abs> --provider <id> --model <id> --reasoning <level> --run <id> --review-cadence <slice|phase|end>",
  "       bearing journey progress --repo <abs> --provider <id> --model <id> --reasoning <level> --run <id> --stage <stage>",
  "       bearing plan validate <plan-directory>",
  "       bearing workspace status [--repo <abs>]",
  "       bearing workspace doctor [--scan <abs>...] [--relocate <abs>]",
  "       bearing workspace compact --compact-settled [--repo <abs>]",
  "       bearing workspace prune (--max-age-days <n> | --max-completed-runs <n>) [--repo <abs>]",
  "       bearing improve status",
  "       bearing improve report",
  "       bearing improve handoff",
  "       bearing improve export --out <relative-path>",
  "",
].join("\n");
const DETACHED_CHILD = "BEARING_DETACHED_CHILD";
/** Backstop so a wedged IPC channel cannot hang the guard child forever. */
const SEND_FLUSH_TIMEOUT_MS = 2_000;
const FOCUS_GUARD_CHILD = "BEARING_FOCUS_GUARD_CHILD";
const MAX_PLAN_SOURCE_BYTES = 2 * 1024 * 1024;

export interface Writer {
  write(s: string): boolean;
}

export interface LauncherDeps {
  /** Invoked once with the selected URL unless `--no-open` is passed. */
  openBrowser?: (url: string) => void;
  stdout?: Writer;
  stderr?: Writer;
  /** Called with a nonzero code on invalid arguments. */
  exit?: (code: number) => void;
  /** Launches the persistent child for `--detach`; injectable for tests. */
  launchDetached?: (args: string[]) => Promise<string>;
  /** Reports readiness from the persistent child to its parent process. */
  notifyReady?: (url: string) => void;
  /** Repository root for guarded standalone focus commands; defaults to cwd. */
  cwd?: string;
  /** Launches the isolated in-memory Focus guard; injectable for tests. */
  launchFocusGuard?: (requestPath: string, cwd: string) => Promise<StandaloneFocusBegin>;
  /** Filesystem/environment seam for bounded workspace commands. */
  workspace?: WorkspaceToolsDeps;
  /** Read-only report and owner-invoked export seam for improvement commands. */
  improvement?: ImprovementCliDeps;
  /** Authenticated local-session transition seam for headless journey commands. */
  headlessJourney?: (request: HeadlessJourneyRequest) => Promise<HeadlessJourneyReceipt>;
}

export type ParseResult = { ok: true; detach: boolean; noOpen: boolean; overrides: RunOverrides } | { ok: false };
export type FocusParseResult = { ok: true; action: "begin"; requestPath: string } | { ok: true; action: "validate"; runId: string; receiptPath: string } | { ok: false };
export type ImproveParseResult =
  | { readonly ok: true; readonly action: "status" | "report" | "handoff" }
  | { readonly ok: true; readonly action: "export"; readonly destination: string }
  | { readonly ok: false };

export type JourneyParseResult =
  | ({ readonly ok: true } & HeadlessJourneyRequest)
  | { readonly ok: false };

export interface ImprovementCliReport {
  readonly settledRuns: number;
  readonly unreadableRuns: number;
  readonly thresholds: Thresholds;
  readonly metrics: MetricCollection | MetricSet;
  readonly recommendation: RecommendationResult;
  readonly trialVerdicts: readonly TrialVerdict[];
}

export type ImprovementCliReportResult =
  | { readonly ok: true; readonly value: ImprovementCliReport }
  | { readonly ok: false; readonly reason: ImprovementServiceFailure };

export interface ImprovementCliDeps {
  readonly report?: (repositoryRoot: string) => Promise<ImprovementCliReportResult>;
  readonly export?: (
    repositoryRoot: string,
    destination: string,
  ) => Promise<ExportContributionResult>;
  readonly storeFactory?: (repositoryRoot: string) => BearingStore;
}
type WorkspaceArgs =
  | { readonly command: "status"; readonly repository?: string }
  | { readonly command: "doctor"; readonly scans: readonly string[]; readonly relocate?: string }
  | { readonly command: "compact"; readonly repository?: string; readonly policy: RetentionPolicy }
  | { readonly command: "prune"; readonly repository?: string; readonly policy: RetentionPolicy };

export function parseFocusArgs(args: string[]): FocusParseResult {
  if (args[0] !== "focus" || !["begin", "validate"].includes(args[1] ?? "")) return { ok: false };
  const values = new Map<string, string>();
  for (let index = 2; index < args.length; index += 1) {
    const name = args[index];
    const value = args[++index];
    if (!/^--(?:request|run|receipt)$/.test(name) || !value || value.startsWith("--") || value.length > 4096 || values.has(name)) return { ok: false };
    values.set(name, value);
  }
  if (args[1] === "begin" && values.size === 1 && values.has("--request")) return { ok: true, action: "begin", requestPath: values.get("--request")! };
  if (args[1] === "validate" && values.size === 2 && values.has("--run") && values.has("--receipt")) return { ok: true, action: "validate", runId: values.get("--run")!, receiptPath: values.get("--receipt")! };
  return { ok: false };
}

function safeImproveDestination(value: string): boolean {
  return value.length > 0
    && value.length <= 1_024
    && value === value.trim()
    && !/[\u0000-\u001f\u007f*<>\\]/.test(value)
    && !isAbsolute(value)
    && !win32.isAbsolute(value)
    && posix.normalize(value) === value
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** Parse the four bounded, credential-free improvement command forms. */
export function parseImproveArgs(args: string[]): ImproveParseResult {
  if (!Array.isArray(args)
    || !Object.hasOwn(args, "length")
    || !Array.from({ length: args.length }, (_, index) => index)
      .every((index) => Object.hasOwn(args, index))) return { ok: false };
  if (args[0] !== "improve") return { ok: false };
  if ((args[1] === "status" || args[1] === "report" || args[1] === "handoff") && args.length === 2) {
    return { ok: true, action: args[1] };
  }
  if (args.length === 4
    && args[1] === "export"
    && args[2] === "--out"
    && safeImproveDestination(args[3])) {
    return { ok: true, action: "export", destination: args[3] };
  }
  return { ok: false };
}

const JOURNEY_ACTIONS = new Set<HeadlessJourneyRequest["action"]>(["create", "resume", "status", "decide", "approve-route", "confirm-amendment", "select-execution", "select-explorer", "progress"]);
const JOURNEY_STAGES = new Set<string>(RECORD_JOURNEY_CHECKPOINT_STAGES);
const JOURNEY_REASONING = new Set<string>(REASONING_VALUES);

function safeJourneyText(value: string | undefined): value is string {
  return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Parse the fixed headless forms; local-session owns every state transition. */
export function parseJourneyArgs(args: string[]): JourneyParseResult {
  if (!Array.isArray(args) || args[0] !== "journey" || !JOURNEY_ACTIONS.has(args[1] as HeadlessJourneyRequest["action"])) return { ok: false };
  const values = new Map<string, string>();
  for (let index = 2; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    if (!/^--(?:repo|provider|model|reasoning|run|goal|answer|mode|review-cadence|stage)$/.test(name ?? "") || value === undefined || value.startsWith("--") || values.has(name)) return { ok: false };
    values.set(name, value);
  }
  const action = args[1] as HeadlessJourneyRequest["action"];
  const repository = values.get("--repo"), provider = values.get("--provider"), model = values.get("--model"), reasoning = values.get("--reasoning"), runId = values.get("--run");
  if (!repository || !isAbsolute(repository) || !safeJourneyText(provider) || !safeJourneyText(model) || !JOURNEY_REASONING.has(reasoning ?? "") || !runId || !/^[A-Za-z0-9_-]{1,128}$/.test(runId)) return { ok: false };
  const common = { action, repository, provider, model, reasoning: reasoning!, runId };
  if (action === "create") {
    const goal = values.get("--goal");
    return values.size === 6 && safeJourneyText(goal) ? { ok: true, ...common, goal } : { ok: false };
  }
  if (action === "decide") {
    const answer = values.get("--answer");
    return values.size === 6 && safeJourneyText(answer) ? { ok: true, ...common, answer } : { ok: false };
  }
  if (action === "select-explorer") {
    const reviewCadence = values.get("--review-cadence");
    return values.size === 6 && (reviewCadence === "slice" || reviewCadence === "phase" || reviewCadence === "end") ? { ok: true, ...common, reviewCadence } : { ok: false };
  }
  if (action === "select-execution") {
    const executionMode = values.get("--mode"), reviewCadence = values.get("--review-cadence");
    return values.size === 7
      && (executionMode === "explorer" || executionMode === "expedition")
      && (reviewCadence === "slice" || reviewCadence === "phase" || reviewCadence === "end")
      ? { ok: true, ...common, executionMode, reviewCadence }
      : { ok: false };
  }
  if (action === "progress") {
    const stage = values.get("--stage");
    return values.size === 6 && stage !== undefined && JOURNEY_STAGES.has(stage) ? { ok: true, ...common, stage: stage as HeadlessJourneyRequest["stage"] } : { ok: false };
  }
  return values.size === 5 ? { ok: true, ...common } : { ok: false };
}

async function readPlanSource(root: string, path: string): Promise<string | undefined> {
  const candidate = resolve(root, path);
  const lexical = relative(root, candidate);
  if (!lexical || lexical.startsWith("..") || isAbsolute(lexical)) return undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    const linked = await lstat(candidate);
    const canonical = await realpath(candidate);
    const relation = relative(root, canonical);
    if (!opened.isFile() || linked.isSymbolicLink() || !linked.isFile() || opened.dev !== linked.dev || opened.ino !== linked.ino || opened.size > MAX_PLAN_SOURCE_BYTES || !relation || relation.startsWith("..") || isAbsolute(relation)) return undefined;
    const content = await handle.readFile("utf8");
    return Buffer.byteLength(content) <= MAX_PLAN_SOURCE_BYTES && content.trim() ? content : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

async function readPlanDocuments(root: string, directory: string): Promise<PlanDocuments | undefined> {
  if (!planDirectoryValid(directory)) return undefined;
  const canonicalRoot = await realpath(root).catch(() => undefined);
  if (!canonicalRoot) return undefined;
  const candidate = resolve(canonicalRoot, directory);
  try {
    const linked = await lstat(candidate);
    const canonical = await realpath(candidate);
    const relation = relative(canonicalRoot, canonical);
    if (!linked.isDirectory() || linked.isSymbolicLink() || !relation || relation.startsWith("..") || isAbsolute(relation)) return undefined;
  } catch {
    return undefined;
  }
  const [plan, design, seit, implementation] = await Promise.all([
    "plan-spec.md",
    "design.md",
    "seit.md",
    "implementation.md",
  ].map((name) => readPlanSource(canonicalRoot, posix.join(directory, name))));
  return plan && design && seit && implementation ? { plan, design, seit, implementation } : undefined;
}

function findingLine(finding: ReturnType<typeof validatePlan>["findings"][number]): string {
  const oneLine = (value: string): string => value
    .replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c)/g, "")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[P^_X][\s\S]*?(?:\u001b\\|\u009c)/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [finding.code, finding.artifact, finding.sliceId ?? "-", finding.observed, finding.required, finding.remedy]
    .map(oneLine)
    .join(" · ");
}

const VALUE_FLAGS = new Set(["agent", "provider", "model", "reasoning", "decision-depth", "tools", "exclude-tools", "timeout", "max-turns", "budget"]);
const BOOLEAN_FLAGS = new Set(["detach", "no-open", "no-session", "offline"]);
const DECISION_DEPTH = new Set(["focused", "standard", "deep"]);
const PER_ROLE = /^(navigator|explorer|crewmate|surveyor)[:=]/i;

function positiveInteger(value: string, max: number): number | undefined {
  if (!/^[1-9][0-9]*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= max ? parsed : undefined;
}

function toolList(value: string): readonly string[] | undefined {
  const tools = value.split(",");
  return tools.length <= 64 && tools.every((tool) => /^[A-Za-z0-9_.:/-]{1,128}$/.test(tool)) && new Set(tools).size === tools.length
    ? tools
    : undefined;
}

function parseWorkspaceArgs(args: string[]): WorkspaceArgs | undefined {
  if (args[0] !== "workspace") return undefined;
  if (args[1] === "status") {
    if (args.length === 2) return { command: "status" };
    return args.length === 4 && args[2] === "--repo" && isAbsolute(args[3])
      ? { command: "status", repository: args[3] }
      : undefined;
  }
  if (args[1] === "compact" || args[1] === "prune") {
    const command = args[1];
    let repository: string | undefined;
    let compactSettled = false;
    let maxAgeDays: number | undefined;
    let maxCompletedRuns: number | undefined;
    for (let index = 2; index < args.length;) {
      const flag = args[index++];
      if (flag === "--compact-settled") {
        if (command !== "compact" || compactSettled) return undefined;
        compactSettled = true;
        continue;
      }
      const value = args[index++];
      if (!value || value.startsWith("--")) return undefined;
      if (flag === "--repo") {
        if (repository !== undefined || !isAbsolute(value)) return undefined;
        repository = value;
        continue;
      }
      const parsed = nonNegativeInteger(value);
      if (parsed === undefined || command !== "prune") return undefined;
      if (flag === "--max-age-days" && maxAgeDays === undefined) {
        maxAgeDays = parsed;
        continue;
      }
      if (flag === "--max-completed-runs" && maxCompletedRuns === undefined) {
        maxCompletedRuns = parsed;
        continue;
      }
      return undefined;
    }
    if (command === "compact") {
      return compactSettled
        ? { command, policy: { compactSettled: true }, ...(repository ? { repository } : {}) }
        : undefined;
    }
    if (maxAgeDays === undefined && maxCompletedRuns === undefined) return undefined;
    return {
      command,
      policy: {
        ...(maxAgeDays === undefined ? {} : { maxAgeDays }),
        ...(maxCompletedRuns === undefined ? {} : { maxCompletedRuns }),
      },
      ...(repository ? { repository } : {}),
    };
  }
  if (args[1] !== "doctor") return undefined;
  const scans: string[] = [];
  let relocate: string | undefined;
  for (let index = 2; index < args.length;) {
    const flag = args[index++];
    if (flag === "--scan") {
      const start = scans.length;
      while (index < args.length && !args[index].startsWith("--")) {
        if (!isAbsolute(args[index])) return undefined;
        scans.push(args[index++]);
      }
      if (scans.length === start) return undefined;
      continue;
    }
    const value = args[index++];
    if (flag !== "--relocate" || relocate !== undefined || !value || !isAbsolute(value)) return undefined;
    relocate = value;
  }
  return { command: "doctor", scans, ...(relocate ? { relocate } : {}) };
}

function nonNegativeInteger(value: string): number | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Parse `start` and the bounded, credential-free shared override set. */
export function parseStartArgs(args: string[]): ParseResult {
  if (args.length === 0) return { ok: false };
  const [command, ...flags] = args;
  if (command !== "start") return { ok: false };
  const values = new Map<string, string | true>();
  for (let index = 0; index < flags.length; index += 1) {
    const raw = flags[index];
    if (!raw.startsWith("--")) return { ok: false };
    const eq = raw.indexOf("=");
    const name = raw.slice(2, eq === -1 ? undefined : eq);
    if (/key|secret|token|credential|password/i.test(name)) return { ok: false };
    if ((!VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name)) || values.has(name)) return { ok: false };
    if (BOOLEAN_FLAGS.has(name)) {
      if (eq !== -1) return { ok: false };
      values.set(name, true);
      continue;
    }
    const value = eq === -1 ? flags[++index] : raw.slice(eq + 1);
    if (!value || value.length > 256 || !/^[\x21-\x7e]+$/.test(value) || value.startsWith("--") || PER_ROLE.test(value)) return { ok: false };
    values.set(name, value);
  }
  const rawReasoning = values.get("reasoning");
  const reasoning = typeof rawReasoning === "string" ? normalizeReasoningTier(rawReasoning, typeof values.get("provider") === "string" ? values.get("provider") as string : undefined) : undefined;
  const decisionDepth = values.get("decision-depth");
  const tools = typeof values.get("tools") === "string" ? toolList(values.get("tools") as string) : undefined;
  const excludedTools = typeof values.get("exclude-tools") === "string" ? toolList(values.get("exclude-tools") as string) : undefined;
  const timeoutMs = typeof values.get("timeout") === "string" ? positiveInteger(values.get("timeout") as string, 2_100_000) : undefined;
  const maxTurns = typeof values.get("max-turns") === "string" ? positiveInteger(values.get("max-turns") as string, 20) : undefined;
  const budget = typeof values.get("budget") === "string" ? positiveInteger(values.get("budget") as string, Number.MAX_SAFE_INTEGER) : undefined;
  if ((values.has("reasoning") && !reasoning) || (decisionDepth !== undefined && (typeof decisionDepth !== "string" || !DECISION_DEPTH.has(decisionDepth))) || (values.has("tools") && !tools) || (values.has("exclude-tools") && !excludedTools) || (tools && excludedTools && tools.some((tool) => excludedTools.includes(tool))) || (values.has("timeout") && !timeoutMs) || (values.has("max-turns") && !maxTurns) || (values.has("budget") && !budget)) return { ok: false };
  return {
    ok: true,
    detach: values.has("detach"),
    noOpen: values.has("no-open"),
    overrides: {
      ...(typeof values.get("agent") === "string" ? { agentRef: values.get("agent") as string } : {}),
      ...(typeof values.get("provider") === "string" ? { provider: values.get("provider") as string } : {}),
      ...(typeof values.get("model") === "string" ? { model: values.get("model") as string } : {}),
      ...(typeof reasoning === "string" ? { reasoning } : {}),
      ...(typeof decisionDepth === "string" ? { decisionDepth: decisionDepth as "focused" | "standard" | "deep" } : {}),
      ...(tools ? { tools } : {}),
      ...(excludedTools ? { excludedTools } : {}),
      ...(values.has("no-session") ? { noSession: true } : {}),
      ...(values.has("offline") ? { offline: true } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(maxTurns ? { maxTurns } : {}),
      ...(budget ? { budget: { tokens: budget } } : {}),
    },
  };
}

type DetachedSpawn = (
  command: string,
  args: string[],
  options: { detached: true; stdio: ["ignore", "ignore", "ignore", "ipc"]; env: NodeJS.ProcessEnv },
) => ChildProcess;

type FocusGuardSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; detached: true; stdio: ["ignore", "ignore", "ignore", "ipc"]; env: NodeJS.ProcessEnv },
) => ChildProcess;

/** Start the standalone validator as a detached process so its state is not agent-writable. */
export function defaultLaunchFocusGuard(requestPath: string, cwd: string, spawnFn: FocusGuardSpawn = spawn): Promise<StandaloneFocusBegin> {
  const child = spawnFn(process.execPath, [fileURLToPath(import.meta.url), "focus", "guard", "--request", requestPath], {
    cwd,
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { ...process.env, [FOCUS_GUARD_CHILD]: "1" },
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: StandaloneFocusBegin) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeAllListeners();
      if (child.connected) child.disconnect();
      child.unref();
      if (error) reject(error);
      else resolve(result!);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("focus guard did not become ready"));
    }, 10_000);
    timeout.unref();
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => finish(new Error(`focus guard exited before ready (${code ?? "signal"})`)));
    child.on("message", (message: unknown) => {
      if (typeof message !== "object" || message === null || (message as { type?: unknown }).type !== "bearing-focus-ready") return;
      const result = (message as { result?: StandaloneFocusBegin }).result;
      if (result && typeof result === "object" && typeof result.ok === "boolean") finish(undefined, result);
    });
  });
}

/** Start a platform-neutral detached copy and wait until it reports its URL. */
export function defaultLaunchDetached(
  args: string[],
  spawnFn: DetachedSpawn = spawn,
): Promise<string> {
  const child = spawnFn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { ...process.env, [DETACHED_CHILD]: "1" },
  });
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeAllListeners();
      child.unref();
      if (error) reject(error);
      else resolve(url!);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("detached launch did not become ready"));
    }, 10_000);
    timeout.unref();
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => finish(new Error(`detached launch exited before ready (${code ?? "signal"})`)));
    child.on("message", (message: unknown) => {
      if (typeof message !== "object" || message === null) return;
      const result = message as { type?: string; url?: string; error?: string };
      if (result.type === "bearing-ready" && typeof result.url === "string") finish(undefined, result.url);
      else if (result.type === "bearing-error") finish(new Error(result.error ?? "detached launch failed"));
    });
  });
}

// ponytail: injected seam only so opener-error safety is testable without a real browser.
export function defaultOpenBrowser(
  url: string,
  spawnFn: (cmd: string, args: string[], opts: { stdio: "ignore"; detached: true }) => ChildProcess = spawn,
): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawnFn(cmd, args, { stdio: "ignore", detached: true });
    // A missing executable emits an async `error` (ENOENT), not a sync throw;
    // attach a listener so an absent opener cannot crash Bearing.
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best-effort: browser opening is not a launch requirement.
  }
}

const DEFAULT_IMPROVEMENT_CLI_DEPS: ImprovementCliDeps = Object.freeze({});

const METRIC_ORDER: readonly MetricValue["id"][] = Object.freeze([
  "coordination-overhead",
  "first-pass-success",
  "grading-accuracy",
  "escaped-defects",
  "cost-per-accepted-criterion",
]);

function metricLabel(id: MetricValue["id"]): string {
  switch (id) {
    case "coordination-overhead": return "coordination overhead";
    case "first-pass-success": return "first-pass success";
    case "grading-accuracy": return "grading accuracy";
    case "escaped-defects": return "escaped defects";
    case "cost-per-accepted-criterion": return "cost per accepted criterion";
  }
}

function metricValues(metrics: MetricCollection | MetricSet): readonly MetricValue[] {
  const record = metrics as Readonly<Record<string, MetricValue>>;
  const values: MetricValue[] = Array.isArray(metrics)
    ? [...metrics] as MetricValue[]
    : Object.keys(record)
      .filter((key) => Object.hasOwn(record, key))
      .map((key) => record[key])
      .filter((value): value is MetricValue => value !== undefined);
  return values.sort((left, right) => METRIC_ORDER.indexOf(left.id) - METRIC_ORDER.indexOf(right.id));
}

function policyValue(value: PolicyValue): string {
  if (value === null) return "none";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return (value as readonly string[]).join(",");
  const pointer = value as { readonly skillName?: string; readonly sectionId?: string };
  if (Object.hasOwn(pointer, "skillName") && Object.hasOwn(pointer, "sectionId")) {
    return `${pointer.skillName}#${pointer.sectionId}`;
  }
  return "pointer";
}

function recommendationDescription(recommendation: Recommendation): string {
  const change = `from ${policyValue(recommendation.from)} to ${policyValue(recommendation.to)}`;
  switch (recommendation.surface) {
    case "reasoning-default": return `change reasoning default ${change}`;
    case "review-cadence": return `tighten review cadence ${change}`;
    case "test-depth": return `increase test depth ${change}`;
    case "concurrency-cap": return `reduce concurrency cap ${change}`;
    case "planning-template": return `add planning requirement ${change}`;
    case "skill-guidance": return `point to skill guidance ${change}`;
  }
}

function patternLabel(patternId: Recommendation["patternId"]): string {
  switch (patternId) {
    case "recurring-retry-fingerprint": return "recurring retry fingerprint";
    case "write-set-overrun": return "write-set overrun";
    case "concurrency-conflict-cluster": return "concurrency conflict cluster";
    case "grader-disagreement": return "grader disagreement";
    case "escaped-defect-concentration": return "escaped defect concentration";
    case "ineffective-escalation": return "ineffective escalation";
  }
}

function trialReason(reason: TrialVerdict["reason"]): string {
  switch (reason) {
    case "target_improved": return "target improved";
    case "target_not_improved": return "target not improved";
    case "target_insufficient": return "target insufficient";
    case "guard_regression": return "guard regression";
    case "guard_insufficient": return "guard insufficient";
    case "evidence_threshold_not_met": return "evidence threshold not met";
  }
}

function improvementStatusLines(report: ImprovementCliReport): readonly string[] {
  return [
    "Improvement status",
    `Settled runs: ${report.settledRuns}`,
    `Unreadable runs: ${report.unreadableRuns}`,
    `Evidence threshold: ${report.thresholds.minSettledRuns} settled runs`,
    `Open trials: ${report.recommendation.recommendations.length}`,
  ];
}

function improvementReportLines(report: ImprovementCliReport): readonly string[] {
  const lines = ["Improvement report"];
  const metrics = metricValues(report.metrics);
  if (metrics.length === 0) lines.push("Metrics: none");
  for (const metric of metrics) {
    lines.push(metric.sufficient && metric.value !== null
      ? `Metric ${metricLabel(metric.id)}: ${metric.numerator}/${metric.denominator} = ${metric.value}`
      : `Metric ${metricLabel(metric.id)}: insufficient (${metric.numerator}/${metric.denominator})`);
  }
  if (report.recommendation.recommendations.length === 0) lines.push("Recommendations: none");
  for (const recommendation of report.recommendation.recommendations) {
    lines.push(`Recommendation ${patternLabel(recommendation.patternId)}: ${recommendationDescription(recommendation)}`);
  }
  if (report.trialVerdicts.length === 0) lines.push("Trial verdicts: none");
  for (const verdict of report.trialVerdicts) {
    lines.push(`Trial ${verdict.status}: ${trialReason(verdict.reason)}; prescribed action ${verdict.prescribedAction}`);
  }
  return lines;
}

function contributionTarget(recommendation: Recommendation): string {
  const target = recommendation.target as Readonly<Record<string, unknown>>;
  if (Object.hasOwn(target, "role") && typeof target.role === "string") return target.role;
  if (Object.hasOwn(target, "layer") && typeof target.layer === "string") return target.layer;
  if (Object.hasOwn(target, "scope") && typeof target.scope === "string") return target.scope;
  if (Object.hasOwn(target, "skillName") && typeof target.skillName === "string"
    && Object.hasOwn(target, "sectionId") && typeof target.sectionId === "string") {
    return `${target.skillName}:${target.sectionId}`;
  }
  if (Object.hasOwn(target, "sectionId") && typeof target.sectionId === "string") return target.sectionId;
  return "invalid/target";
}

function contributionAtom(value: PolicyValue): ContributionPolicyValue["from"] {
  if (value === null) return "none";
  if (typeof value === "string" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.join(":");
  const pointer = value as Readonly<Record<string, unknown>>;
  return typeof pointer.skillName === "string" && typeof pointer.sectionId === "string"
    ? `${pointer.skillName}:${pointer.sectionId}`
    : "invalid/value";
}

function contributionBundle(report: ImprovementCliReport): ContributionBundle {
  const policyValues: ContributionPolicyValue[] = [];
  for (let index = 0; index < report.recommendation.recommendations.length; index += 1) {
    if (report.trialVerdicts[index]?.status !== "retain") continue;
    const recommendation = report.recommendation.recommendations[index];
    if (!recommendation) continue;
    policyValues.push({
      surface: recommendation.surface,
      target: contributionTarget(recommendation),
      from: contributionAtom(recommendation.from),
      to: contributionAtom(recommendation.to),
      verdict: "retain",
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    policyValues: Object.freeze(policyValues),
    benchmarkCases: Object.freeze([]),
    testCases: Object.freeze([]),
    workflowNotes: Object.freeze([]),
  });
}

function improvementStore(
  improvement: ImprovementCliDeps,
  repositoryRoot: string,
): BearingStore {
  if (Object.hasOwn(improvement, "storeFactory")) {
    if (typeof improvement.storeFactory !== "function") throw new Error("configuration_invalid");
    return improvement.storeFactory(repositoryRoot);
  }
  return new BearingStore(repositoryRoot);
}

/**
 * Name the cause of an `export_failed` write so the owner can act on it. Read-only: it inspects the
 * destination and its parent and never creates either. Returns "" when the cause is not one of the
 * two it can identify, so the bare reason is still printed rather than a wrong explanation.
 */
async function exportFailureDetail(repositoryRoot: string, destination: string): Promise<string> {
  const target = resolve(repositoryRoot, destination);
  const parent = resolve(target, "..");
  if (await lstat(target).then(() => true, () => false)) {
    return ": the destination already exists and is never overwritten; choose another path";
  }
  if (!await lstat(parent).then((entry) => entry.isDirectory(), () => false)) {
    return `: the destination directory does not exist; create it first, or export to a path inside an existing directory`;
  }
  return "";
}

async function loadImprovementReport(
  improvement: ImprovementCliDeps,
  repositoryRoot: string,
): Promise<ImprovementCliReportResult> {
  if (Object.hasOwn(improvement, "report")) {
    return typeof improvement.report === "function"
      ? improvement.report(repositoryRoot)
      : { ok: false, reason: "configuration_invalid" };
  }
  try {
    return await buildImprovementReport(improvementStore(improvement, repositoryRoot));
  } catch {
    return { ok: false, reason: "store_read_failed" };
  }
}

/**
 * Run the launcher. On success resolves to the listening loopback `Server`.
 * On invalid arguments, writes usage to stderr, calls `exit(2)`, and resolves
 * to `undefined`. The browser opener fires exactly once for `start` and never
 * for `start --no-open`.
 */
export function run(args: string[], deps: LauncherDeps = {}): Promise<Server | undefined> {
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  if (args[0] === "improve") {
    const parsed = parseImproveArgs(args);
    if (!parsed.ok) {
      stderr.write(USAGE);
      exit(2);
      return Promise.resolve(undefined);
    }
    const repositoryRoot = Object.hasOwn(deps, "cwd") && typeof deps.cwd === "string"
      ? deps.cwd
      : process.cwd();
    if (!Object.hasOwn(deps, "improvement") && "improvement" in deps) {
      stderr.write("bearing improve: configuration_invalid\n");
      exit(1);
      return Promise.resolve(undefined);
    }
    const improvement = Object.hasOwn(deps, "improvement") && deps.improvement
      ? deps.improvement
      : DEFAULT_IMPROVEMENT_CLI_DEPS;
    if (parsed.action === "handoff") {
      let store: BearingStore;
      try {
        const storeFactory = Object.hasOwn(improvement, "storeFactory")
          && typeof improvement.storeFactory === "function"
          ? improvement.storeFactory
          : (root: string): BearingStore => new BearingStore(root);
        store = storeFactory(repositoryRoot);
      } catch {
        stderr.write("bearing improve: run_unavailable\n");
        exit(1);
        return Promise.resolve(undefined);
      }
      return buildImprovementHandoffFacts(store).then((result) => {
        if (!result.ok) {
          stderr.write(`bearing improve: ${result.reason}\n`);
          exit(1);
          return undefined;
        }
        stdout.write(renderImprovementHandoff(result.value));
        return undefined;
      }).catch(() => {
        stderr.write("bearing improve: run_unavailable\n");
        exit(1);
        return undefined;
      });
    }
    if (parsed.action === "export") {
      const operation: Promise<ExportContributionResult | { readonly ok: false; readonly reason: ImprovementServiceFailure }> =
        Object.hasOwn(improvement, "export")
          ? typeof improvement.export === "function"
            ? improvement.export(repositoryRoot, parsed.destination)
            : Promise.resolve({ ok: false, reason: "configuration_invalid" })
          : (async () => {
            const report = await loadImprovementReport(improvement, repositoryRoot);
            return report.ok
              ? await exportContributionBundle({
                repositoryRoot,
                destination: parsed.destination,
                bundle: contributionBundle(report.value),
              })
              : report;
          })();
      return operation.then(async (result) => {
        if (!result.ok) {
          // `export_failed` is the export module's single write-failure reason and covers at least
          // two very different situations: the destination's parent directory does not exist, and
          // the destination file already exists (the write uses the exclusive `wx` flag). Neither
          // is actionable from the bare code, so name the cause here rather than widening the
          // module's failure vocabulary.
          const detail = result.reason !== "export_failed"
            ? ""
            : await exportFailureDetail(repositoryRoot, parsed.destination);
          stderr.write(`bearing improve: ${result.reason}${detail}\n`);
          exit(1);
          return undefined;
        }
        stdout.write(`Exported improvement bundle: ${result.destination}\n`);
        return undefined;
      }).catch(() => {
        stderr.write("bearing improve: export_failed\n");
        exit(1);
        return undefined;
      });
    }
    return loadImprovementReport(improvement, repositoryRoot).then((result) => {
      if (!result.ok) {
        stderr.write(`bearing improve: ${result.reason}\n`);
        exit(1);
        return undefined;
      }
      const lines = parsed.action === "status"
        ? improvementStatusLines(result.value)
        : improvementReportLines(result.value);
      for (const line of lines) stdout.write(`${line}\n`);
      return undefined;
    }).catch(() => {
      stderr.write("bearing improve: stage_failed\n");
      exit(1);
      return undefined;
    });
  }

  if (args[0] === "plan") {
    if (args.length !== 3 || args[1] !== "validate") {
      stderr.write("bearing plan validate: plan_input_invalid\n");
      exit(3);
      return Promise.resolve(undefined);
    }
    const directory = args[2];
    return readPlanDocuments(deps.cwd ?? process.cwd(), directory).then((documents) => {
      if (!documents) {
        stderr.write("bearing plan validate: plan_input_invalid\n");
        exit(3);
        return undefined;
      }
      const result = validatePlan({ documents, planDirectory: directory });
      stdout.write(`${result.verdict}\n`);
      for (const finding of result.findings) stdout.write(`${findingLine(finding)}\n`);
      const code = result.verdict === "PASS" ? 0 : result.verdict === "NEEDS_AMENDMENT" ? 1 : 2;
      if (code) exit(code);
      return undefined;
    }).catch(() => {
      stderr.write("bearing plan validate: plan_input_invalid\n");
      exit(3);
      return undefined;
    });
  }

  if (process.env[FOCUS_GUARD_CHILD] === "1" && args[0] === "focus" && args[1] === "guard" && args[2] === "--request" && args.length === 4) {
    return beginStandaloneFocus(deps.cwd ?? process.cwd(), args[3]).then((result) => {
      return new Promise<undefined>((resolve) => {
        const finish = () => {
          process.disconnect?.();
          if (!result.ok) exit(1);
          resolve(undefined);
        };
        // `send` only invokes its callback once the channel flushes, so a wedged
        // parent could otherwise leave this promise pending forever; a bounded
        // backstop guarantees the child settles. Deliberately ignore the boolean
        // return: it is false for ordinary backpressure as well as a closed
        // channel, and treating backpressure as failure would disconnect and exit
        // while the ready message is still queued, dropping it.
        if (!process.send) { finish(); return; }
        const settle = setTimeout(finish, SEND_FLUSH_TIMEOUT_MS);
        settle.unref();
        process.send({ type: "bearing-focus-ready", result }, () => {
          clearTimeout(settle);
          finish();
        });
      });
    });
  }

  if (args[0] === "journey") {
    const parsedJourney = parseJourneyArgs(args);
    if (!parsedJourney.ok) {
      stderr.write(USAGE);
      exit(2);
      return Promise.resolve(undefined);
    }
    const transition = deps.headlessJourney ?? ((request: HeadlessJourneyRequest) => executeHeadlessJourney(request, {
      processRunner: new NodeProcessRunner(),
    }));
    return transition(parsedJourney).then((receipt) => {
      stdout.write(`${JSON.stringify(receipt)}\n`);
      if (!receipt.ok) exit(1);
      return undefined;
    }).catch(() => {
      stdout.write(`${JSON.stringify({ ok: false, code: "transition_unavailable", runId: parsedJourney.runId, revision: 0 } satisfies HeadlessJourneyReceipt)}\n`);
      exit(1);
      return undefined;
    });
  }

  if (args[0] === "focus") {
    const parsedFocus = parseFocusArgs(args);
    if (!parsedFocus.ok) {
      stderr.write(USAGE);
      exit(2);
      return Promise.resolve(undefined);
    }
    const cwd = deps.cwd ?? process.cwd();
    const operation = parsedFocus.action === "begin"
      ? (deps.launchFocusGuard ?? defaultLaunchFocusGuard)(parsedFocus.requestPath, cwd)
      : validateStandaloneFocus(cwd, parsedFocus.runId, parsedFocus.receiptPath);
    return operation.then((result) => {
      stdout.write(`${JSON.stringify(result)}\n`);
      if (!result.ok) exit(1);
      return undefined;
    });
  }

  if (args[0] === "workspace") {
    const workspace = parseWorkspaceArgs(args);
    if (!workspace) {
      stderr.write(USAGE);
      exit(2);
      return Promise.resolve(undefined);
    }
    const command = workspace.command === "status"
      ? workspaceStatus(workspace.repository, deps.workspace).then((lines) => ({ ok: true, lines }))
      : workspace.command === "doctor"
        ? workspaceDoctor(workspace, deps.workspace)
        : workspace.command === "compact"
          ? workspaceCompact({
            repository: workspace.repository,
            policy: workspace.policy,
            onPlan: (lines) => {
              for (const line of lines) stdout.write(`${line}\n`);
            },
          }, deps.workspace)
          : workspacePrune({
            repository: workspace.repository,
            policy: workspace.policy,
            onPlan: (lines) => {
              for (const line of lines) stdout.write(`${line}\n`);
            },
          }, deps.workspace);
    return command.then((result) => {
      const writer = result.ok ? stdout : stderr;
      for (const line of result.lines) writer.write(`${line}\n`);
      if (!result.ok) exit(1);
      return undefined;
    }).catch((error: unknown) => {
      stderr.write(`bearing workspace: ${error instanceof Error ? error.message : String(error)}\n`);
      exit(1);
      return undefined;
    });
  }

  const parsed = parseStartArgs(args);
  if (!parsed.ok) {
    stderr.write(USAGE);
    exit(2);
    return Promise.resolve(undefined);
  }

  if (parsed.detach) {
    const childArgs = args.filter((arg) => arg !== "--detach");
    return (deps.launchDetached ?? defaultLaunchDetached)(childArgs).then((url) => {
      stdout.write(`${url}\n`);
      return undefined;
    });
  }

  return new Promise<Server>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      const boundHost = `127.0.0.1:${port}`;
      // ponytail: capability in the fragment so the initial GET and Referer never carry it.
      const session = new LocalSessionService(boundHost);
      const processRunner = new NodeProcessRunner();
      server.on("request", createRequestHandler(session, undefined, {
        startupOverrides: parsed.overrides,
        processRunner,
      }));
      const url = `http://${boundHost}/#cap=${session.capability}`;
      stdout.write(`${url}\n`);
      if (!parsed.noOpen) openBrowser(url);
      deps.notifyReady?.(url);
      resolve(server);
    });
  });
}

function main(argv: string[]): void {
  const detachedChild = process.env[DETACHED_CHILD] === "1" && typeof process.send === "function";
  const deps: LauncherDeps = detachedChild ? {
    stdout: { write: () => true },
    notifyReady: (url) => {
      process.send?.({ type: "bearing-ready", url }, () => process.disconnect());
    },
  } : {};
  run(argv, deps).catch((err: unknown) => {
    if (detachedChild) {
      process.send?.({ type: "bearing-error", error: String(err) }, () => process.disconnect());
    }
    process.stderr.write(`bearing: ${String(err)}\n`);
    process.exit(1);
  });
}

export function isDirectInvocation(executablePath = process.argv[1]): boolean {
  if (!executablePath) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(executablePath)).href;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) main(process.argv.slice(2));
