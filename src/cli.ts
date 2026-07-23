#!/usr/bin/env node
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NodeProcessRunner } from "./adapters/process-runner.js";
import { REASONING_LEVELS } from "./onboarding/readiness.js";
import type { RunOverrides } from "./profile/profile.js";
import {
  LocalSessionService,
  createRequestHandler,
} from "./server/local-session.js";

const USAGE = "usage: bearing start [--detach] [--no-open] [safe shared overrides]\n";
const DETACHED_CHILD = "BEARING_DETACHED_CHILD";

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
}

export type ParseResult = { ok: true; detach: boolean; noOpen: boolean; overrides: RunOverrides } | { ok: false };

const VALUE_FLAGS = new Set(["agent", "provider", "model", "reasoning", "decision-depth", "tools", "exclude-tools", "timeout", "max-turns", "budget"]);
const BOOLEAN_FLAGS = new Set(["detach", "no-open", "no-session", "offline"]);
const REASONING = new Set<string>(REASONING_LEVELS);
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
  const reasoning = values.get("reasoning");
  const decisionDepth = values.get("decision-depth");
  const tools = typeof values.get("tools") === "string" ? toolList(values.get("tools") as string) : undefined;
  const excludedTools = typeof values.get("exclude-tools") === "string" ? toolList(values.get("exclude-tools") as string) : undefined;
  const timeoutMs = typeof values.get("timeout") === "string" ? positiveInteger(values.get("timeout") as string, 2_100_000) : undefined;
  const maxTurns = typeof values.get("max-turns") === "string" ? positiveInteger(values.get("max-turns") as string, 20) : undefined;
  const budget = typeof values.get("budget") === "string" ? positiveInteger(values.get("budget") as string, Number.MAX_SAFE_INTEGER) : undefined;
  if ((reasoning !== undefined && (typeof reasoning !== "string" || !REASONING.has(reasoning))) || (decisionDepth !== undefined && (typeof decisionDepth !== "string" || !DECISION_DEPTH.has(decisionDepth))) || (values.has("tools") && !tools) || (values.has("exclude-tools") && !excludedTools) || (tools && excludedTools && tools.some((tool) => excludedTools.includes(tool))) || (values.has("timeout") && !timeoutMs) || (values.has("max-turns") && !maxTurns) || (values.has("budget") && !budget)) return { ok: false };
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

export function defaultOpenBrowser(
  url: string,
  // ponytail: injected seam only so the opener-error safety is testable without a real browser.
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
