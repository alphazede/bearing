import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ProcessActivity, ProcessInvocation, ProcessResult, ProcessRunner, RouteDescriptor, RouteModelOption } from "./adapters.js";

const MAX_STDOUT = 1024 * 1024;
const MAX_STDERR = 64 * 1024;
const MAX_EVENT_TEXT = 512 * 1024;
const MAX_ACTIVITIES = 1024;
const SAFE_ACTIVITY_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

type SpawnPort = (executable: string, args: readonly string[], options: {
  readonly cwd: string;
  readonly shell: false;
  readonly detached: true;
  readonly stdio: ["pipe", "pipe", "pipe"];
  readonly env?: NodeJS.ProcessEnv;
}) => ChildProcessWithoutNullStreams;
type ResolvePort = (executable: string, cwd: string) => { executable: string; cwd: string } | undefined;
type InspectPort = (executable: string, args: readonly string[], cwd: string) => string;

function available(executable: string): boolean {
  const candidates = executable.includes("/") ? [executable] : (process.env.PATH ?? "").split(delimiter).filter(isAbsolute).map((directory) => join(directory, executable));
  return candidates.some((candidate) => { try { accessSync(candidate, constants.X_OK); return true; } catch { return false; } });
}

function resolveSpawn(executable: string, cwd: string): { executable: string; cwd: string } | undefined {
  try {
    const canonicalCwd = realpathSync(cwd);
    if (!statSync(canonicalCwd).isDirectory() || canonicalCwd !== cwd) return undefined;
    const candidates = isAbsolute(executable) ? [executable] : (process.env.PATH ?? "").split(delimiter).filter(isAbsolute).map((directory) => join(directory, executable));
    for (const candidate of candidates) {
      try {
        accessSync(candidate, constants.X_OK);
        const resolved = realpathSync(candidate);
        const relation = relative(canonicalCwd, resolved);
        if (relation && !relation.startsWith("..") && !isAbsolute(relation)) continue;
        return { executable: resolved, cwd: canonicalCwd };
      } catch { /* try the next PATH entry */ }
    }
  } catch { /* fail closed */ }
  return undefined;
}

function signal(child: ChildProcessWithoutNullStreams, kind: NodeJS.Signals): void {
  if (child.pid && process.platform !== "win32") {
    try { process.kill(-child.pid, kind); return; } catch { /* child may already be gone */ }
  }
  try { child.kill(kind); } catch { /* child may already be gone */ }
}

function terminate(child: ChildProcessWithoutNullStreams): void {
  let closed = false;
  child.once("close", () => { closed = true; });
  signal(child, "SIGTERM");
  const force = setTimeout(() => { if (!closed) signal(child, "SIGKILL"); }, 250);
  force.unref();
}

function tokenUsage(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const part = typeof record.part === "object" && record.part !== null ? record.part as Record<string, unknown> : undefined;
  const usage = typeof part?.tokens === "object" && part.tokens !== null ? part.tokens as Record<string, unknown> : typeof record.usage === "object" && record.usage !== null ? record.usage as Record<string, unknown> : record;
  const direct = usage.tokens ?? usage.total_tokens ?? usage.totalTokens;
  if (Number.isSafeInteger(direct) && (direct as number) >= 0) return direct as number;
  const parts = [usage.input_tokens, usage.output_tokens, usage.input, usage.output, usage.reasoning].filter((entry): entry is number => Number.isSafeInteger(entry) && (entry as number) >= 0);
  if (parts.length) return parts.reduce((sum, entry) => sum + entry, 0);
  return Number.isSafeInteger(usage.cached_input_tokens) && (usage.cached_input_tokens as number) >= 0 ? usage.cached_input_tokens as number : undefined;
}

const SECRET = /(?:\b(?:api[_ -]?key|secret|token|password|authorization)\s*[=:]\s*|\bBearer\s+|\bsk-[A-Za-z0-9_-]{8,}|\bAKIA[A-Z0-9]{16})[^\s,;]*/gi;
const EVENT_DATA_KEYS = new Set(["id", "name", "message", "text", "content", "status", "summary", "detail", "result", "tool"]);
function safe(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") return value.replace(SECRET, "[redacted]").slice(0, MAX_EVENT_TEXT);
  if (Array.isArray(value)) return value.slice(0, 64).map((entry) => safe(entry, depth + 1));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).slice(0, 64).flatMap(([key, entry]) => EVENT_DATA_KEYS.has(key) && !/key|secret|token|credential|authorization|password/i.test(key) ? [[key, safe(entry, depth + 1)]] : []));
}

function normalize(stdout: string, routeId: string): { events: readonly unknown[]; usage: { tokens: number }; providerSessionId?: string } | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  let values: unknown[];
  try {
    const parsed = JSON.parse(trimmed);
    values = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    try { values = trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
    catch { return routeId === "agy" ? { events: [{ type: "complete", data: { content: safe(trimmed) } }], usage: { tokens: 0 } } : undefined; }
  }
  if (!values.length || values.length > 1024 || values.some((value) => typeof value !== "object" || value === null || Array.isArray(value))) return undefined;
  let tokens: number | undefined;
  let providerSessionId: string | undefined;
  const events = values.map((value) => {
    const record = value as Record<string, unknown>;
    if (routeId === "codex" && record.type === "thread.started" && typeof record.thread_id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.thread_id)) providerSessionId = record.thread_id;
    const found = tokenUsage(record);
    if (found !== undefined) tokens = routeId === "opencode" ? (tokens ?? 0) + found : found;
    const type = typeof record.type === "string" ? record.type : typeof record.event === "string" ? record.event : "message";
    const item = typeof record.item === "object" && record.item !== null && !Array.isArray(record.item) ? record.item as Record<string, unknown> : undefined;
    const part = typeof record.part === "object" && record.part !== null && !Array.isArray(record.part) ? record.part as Record<string, unknown> : undefined;
    const agentMessage = type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string" ? item.text : undefined;
    const partText = typeof part?.text === "string" ? part.text : undefined;
    const data = agentMessage ?? partText ?? record.data ?? record.message ?? record.text ?? record.content ?? record.result ?? record.status;
    return { type, ...(data === undefined ? {} : { data: typeof data === "object" && data !== null && !Array.isArray(data) ? safe(data) : { content: safe(data) } }) };
  });
  return tokens === undefined ? undefined : { events, usage: { tokens }, ...(providerSessionId ? { providerSessionId } : {}) };
}

function mayHaveSideEffect(stdout: string): boolean {
  return /"(?:type|event)"\s*:\s*"[^"]*(?:tool|command|exec)/i.test(stdout);
}

function activity(line: string, sequence: number): ProcessActivity | undefined {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return undefined; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const kind = activityValue(record.type) ?? activityValue(record.event);
  if (!kind) return undefined;
  const item = object(record.item);
  const tool = object(record.tool);
  const status = activityValue(record.status) ?? activityValue(item?.status);
  const itemType = activityValue(item?.type);
  const toolLike = /tool|command|exec/i.test(kind) || (itemType !== undefined && /tool|command|exec/i.test(itemType));
  const toolName = activityValue(record.tool)
    ?? activityValue(tool?.name)
    ?? (toolLike ? activityValue(item?.name) ?? activityValue(record.name) ?? itemType : undefined);
  return { sequence, kind, ...(status ? { status } : {}), ...(toolName ? { tool: toolName } : {}) };
}

function activityValue(value: unknown): string | undefined {
  if (typeof value !== "string" || !SAFE_ACTIVITY_VALUE.test(value)) return undefined;
  return value.replace(SECRET, "[redacted]") === value ? value : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Dependency-free production process port. Raw output is discarded after normalization. */
export class NodeProcessRunner implements ProcessRunner {
  private readonly children = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly cancelled = new Set<string>();

  constructor(private readonly spawnProcess: SpawnPort = spawn, private readonly inspectExecutable: (executable: string) => boolean = available, private readonly resolveExecutable: ResolvePort = resolveSpawn, private readonly inspectProcess: InspectPort = inspectLines) {}

  executableAvailable(executable: string): boolean { return this.inspectExecutable(executable); }

  currentSelection(route: RouteDescriptor): { model: string; reasoning: string } {
    try {
      if (route.provider === "codex") {
        const head = readFileSync(join(homedir(), ".codex", "config.toml"), "utf8").split(/^\[/m, 1)[0] ?? "";
        return { model: tomlString(head, "model") ?? "*", reasoning: tomlString(head, "model_reasoning_effort") ?? "medium" };
      }
      if (route.provider === "claude") {
        const settings = jsonObject(join(homedir(), ".claude", "settings.json"));
        return { model: text(settings.model) ?? "*", reasoning: text(settings.effortLevel) ?? "medium" };
      }
      if (route.provider === "pi") {
        const configured = text(process.env.PI_CODING_AGENT_DIR);
        const settingsRoot = configured && isAbsolute(configured) ? configured : join(homedir(), ".pi", "agent");
        const settings = jsonObject(join(settingsRoot, "settings.json"));
        const provider = text(settings.defaultProvider), model = text(settings.defaultModel);
        return { model: provider && model ? `${provider}/${model}` : "*", reasoning: text(settings.defaultThinkingLevel) ?? "medium" };
      }
      if (route.provider === "opencode") {
        const settings = jsonObject(join(homedir(), ".config", "opencode", "opencode.json"));
        return { model: text(settings.model) ?? "*", reasoning: "default" };
      }
    } catch { /* use the route default */ }
    return { model: route.model, reasoning: "medium" };
  }

  modelOptions(route: RouteDescriptor, repositoryPath = process.cwd()): readonly RouteModelOption[] {
    const current = this.currentSelection(route);
    try {
      if (route.provider === "codex") {
        const cache = jsonObject(join(homedir(), ".codex", "models_cache.json"));
        const models = Array.isArray(cache.models) ? cache.models : [];
        const options = models.flatMap((entry): RouteModelOption[] => {
          if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
          const model = text((entry as Record<string, unknown>).slug);
          const supported = (entry as Record<string, unknown>).supported_reasoning_levels;
          const levels = Array.isArray(supported) ? supported.flatMap((level) => typeof level === "object" && level !== null && !Array.isArray(level) ? [text((level as Record<string, unknown>).effort)].filter((value): value is string => !!value) : []) : [];
          if (!model || !levels.length) return [];
          const defaultReasoning = text((entry as Record<string, unknown>).default_reasoning_level) ?? levels[0];
          return [{ model, label: text((entry as Record<string, unknown>).display_name) ?? model, reasoningLevels: levels, defaultReasoning }];
        });
        if (options.length) return options.slice(0, 64);
      }
      if (route.provider === "claude") return uniqueModels([current.model, "sonnet", "opus", "haiku", "fable"], route.reasoningLevels, current.reasoning);
      if (route.provider === "agy") return this.inspectRoute(route, ["models"], repositoryPath).flatMap((line): RouteModelOption[] => {
        const match = /^(.*?) \((Low|Medium|High|Thinking)\)$/.exec(line);
        if (!match) return [];
        const reasoning = match[2].toLowerCase();
        return [{ model: line, label: line, reasoningLevels: [reasoning], defaultReasoning: reasoning }];
      }).slice(0, 64);
      if (route.provider === "grok") return [{ model: "grok-build", label: "Grok Build", reasoningLevels: route.reasoningLevels, defaultReasoning: route.reasoningLevels.includes(current.reasoning) ? current.reasoning : "medium" }];
      if (route.provider === "opencode") return this.inspectRoute(route, ["models"], repositoryPath).filter((line) => /^[a-z0-9._-]+\/[A-Za-z0-9._:/-]+$/.test(line)).slice(0, 64).map((model) => {
        const levels = opencodeReasoning(model.split("/", 1)[0] ?? "");
        return { model, label: model, reasoningLevels: levels, defaultReasoning: levels[0] };
      });
      if (route.provider === "pi") return this.inspectRoute(route, ["--list-models"], repositoryPath).slice(1).flatMap((line): RouteModelOption[] => {
        const columns = line.trim().split(/\s+/);
        if (columns.length < 6) return [];
        const model = `${columns[0]}/${columns[1]}`;
        const levels = columns[4] === "yes" ? ["off", "minimal", "low", "medium", "high", "xhigh"] : ["off"];
        return [{ model, label: model, reasoningLevels: levels, defaultReasoning: levels.includes(current.reasoning) ? current.reasoning : levels[0] }];
      }).slice(0, 64);
    } catch { /* fall through to the configured/default model */ }
    const model = current.model === "*" ? route.model : current.model;
    return [{ model, label: model === "*" ? "Agent default" : model, reasoningLevels: route.reasoningLevels, defaultReasoning: route.reasoningLevels.includes(current.reasoning) ? current.reasoning : route.reasoningLevels[0] }];
  }

  private inspectRoute(route: RouteDescriptor, args: readonly string[], repositoryPath: string): string[] {
    const resolved = this.resolveExecutable(route.executable, repositoryPath);
    if (!resolved) throw new Error("unsafe inspection executable");
    const output = this.inspectProcess(resolved.executable, args, resolved.cwd);
    return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }

  cancel(runId: string): void {
    if (this.cancelled.has(runId)) return;
    this.cancelled.add(runId);
    const child = this.children.get(runId);
    if (child) terminate(child);
  }

  run(invocation: ProcessInvocation): Promise<ProcessResult> {
    if (this.cancelled.has(invocation.runId)) return Promise.resolve({ cancelled: true });
    const spawn = this.resolveExecutable(invocation.executable, invocation.cwd);
    if (!spawn) return Promise.resolve({ exitCode: 1 });
    return new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      let promptDirectory: string | undefined;
      let args = invocation.args;
      let environment = invocation.environment;
      try {
        if (invocation.promptFile) {
          promptDirectory = mkdtempSync(join(tmpdir(), "bearing-prompt-"));
          const promptPath = join(promptDirectory, "task.md");
          writeFileSync(promptPath, invocation.stdin, { encoding: "utf8", mode: 0o600 });
          args = invocation.args.map((argument) => argument.replaceAll("__BEARING_PROMPT_FILE__", promptPath).replaceAll("__BEARING_PROMPT_DIR__", promptDirectory!));
          environment = environment && Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, value.replaceAll("__BEARING_PROMPT_FILE__", promptPath).replaceAll("__BEARING_PROMPT_DIR__", promptDirectory!)]));
        }
        child = this.spawnProcess(spawn.executable, args, { cwd: spawn.cwd, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"], ...(environment ? { env: { ...process.env, ...environment } } : {}) });
      } catch {
        if (promptDirectory) rmSync(promptDirectory, { recursive: true, force: true });
        resolve({ exitCode: 1 });
        return;
      }
      this.children.set(invocation.runId, child);
      const stdout: Buffer[] = [];
      let stdoutSize = 0;
      let stderrSize = 0;
      let overflow = false;
      let settled = false;
      const decoder = invocation.onActivity ? new StringDecoder("utf8") : undefined;
      let activityRemainder = "";
      let activitySequence = 0;
      const emitActivity = (line: string): void => {
        if (!invocation.onActivity || activitySequence >= MAX_ACTIVITIES) return;
        const projected = activity(line.replace(/\r$/, ""), activitySequence + 1);
        if (!projected) return;
        activitySequence += 1;
        try { invocation.onActivity(projected); } catch { /* observers cannot affect execution */ }
      };
      const flushActivity = (): void => {
        if (!decoder || overflow) return;
        const line = `${activityRemainder}${decoder.end()}`;
        if (line.trim()) emitActivity(line);
        activityRemainder = "";
      };
      const finish = (result: ProcessResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.children.delete(invocation.runId);
        if (promptDirectory) rmSync(promptDirectory, { recursive: true, force: true });
        resolve(result);
      };
      const captured = (): string => Buffer.concat(stdout).toString("utf8");
      const timer = setTimeout(() => { terminate(child); finish(mayHaveSideEffect(captured()) ? { unknownSideEffect: true } : { timedOut: true }); }, invocation.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled || overflow) return;
        stdoutSize += chunk.length;
        if (stdoutSize > MAX_STDOUT) { overflow = true; terminate(child); return; }
        stdout.push(chunk);
        if (decoder) {
          const lines = `${activityRemainder}${decoder.write(chunk)}`.split("\n");
          activityRemainder = lines.pop() ?? "";
          for (const line of lines) emitActivity(line);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (settled || overflow) return;
        stderrSize += chunk.length;
        if (stderrSize > MAX_STDERR) { overflow = true; terminate(child); }
      });
      child.on("error", () => finish({ exitCode: 1 }));
      child.on("close", (code) => {
        if (settled) return;
        flushActivity();
        const body = captured();
        if (this.cancelled.has(invocation.runId)) { finish(mayHaveSideEffect(body) ? { unknownSideEffect: true } : { cancelled: true }); return; }
        if (overflow) { finish(mayHaveSideEffect(body) ? { unknownSideEffect: true } : { exitCode: 0, events: "oversized" }); return; }
        if (code !== 0) { finish(mayHaveSideEffect(body) ? { unknownSideEffect: true } : { exitCode: code ?? 1 }); return; }
        const parsed = normalize(body, invocation.routeId);
        if (!parsed) { finish({ unknownSideEffect: true }); return; }
        finish({ exitCode: 0, ...parsed });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(invocation.promptFile ? undefined : invocation.stdin);
    });
  }
}

function inspectLines(executable: string, args: readonly string[], cwd: string): string {
  const output = execFileSync(executable, args, { cwd, encoding: "utf8", timeout: 5_000, maxBuffer: 512 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  return output;
}

function uniqueModels(models: readonly string[], reasoningLevels: readonly string[], preferred: string): RouteModelOption[] {
  return [...new Set(models.filter((model) => model && model.length <= 256))].map((model) => ({ model, label: model === "*" || model === "default" ? "Agent default" : model, reasoningLevels, defaultReasoning: reasoningLevels.includes(preferred) ? preferred : reasoningLevels[0] }));
}

function opencodeReasoning(provider: string): readonly string[] {
  if (provider === "openai") return ["default", "none", "minimal", "low", "medium", "high", "xhigh"];
  if (provider === "anthropic") return ["default", "high", "max"];
  if (provider === "google") return ["default", "low", "high"];
  return ["default"];
}

function text(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined; }
function jsonObject(path: string): Record<string, unknown> { const value = JSON.parse(readFileSync(path, "utf8")) as unknown; return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function tomlString(source: string, key: string): string | undefined { const match = new RegExp(`^${key}\\s*=\\s*"([^"]{1,256})"\\s*$`, "m").exec(source); return match ? match[1] : undefined; }
