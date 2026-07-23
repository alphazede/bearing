#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NodeProcessRunner } from "./adapters/process-runner.js";
import { REASONING_LEVELS } from "./onboarding/readiness.js";
import { beginStandaloneFocus, validateStandaloneFocus } from "./journey/standalone-focus.js";
import { LocalSessionService, createRequestHandler, } from "./server/local-session.js";
const USAGE = "usage: bearing start [--detach] [--no-open] [safe shared overrides]\n       bearing focus begin --request <relative-json>\n       bearing focus validate --run <opaque-run-id> --receipt <relative-json>\n";
const DETACHED_CHILD = "BEARING_DETACHED_CHILD";
const FOCUS_GUARD_CHILD = "BEARING_FOCUS_GUARD_CHILD";
export function parseFocusArgs(args) {
    if (args[0] !== "focus" || !["begin", "validate"].includes(args[1] ?? ""))
        return { ok: false };
    const values = new Map();
    for (let index = 2; index < args.length; index += 1) {
        const name = args[index];
        const value = args[++index];
        if (!/^--(?:request|run|receipt)$/.test(name) || !value || value.startsWith("--") || value.length > 4096 || values.has(name))
            return { ok: false };
        values.set(name, value);
    }
    if (args[1] === "begin" && values.size === 1 && values.has("--request"))
        return { ok: true, action: "begin", requestPath: values.get("--request") };
    if (args[1] === "validate" && values.size === 2 && values.has("--run") && values.has("--receipt"))
        return { ok: true, action: "validate", runId: values.get("--run"), receiptPath: values.get("--receipt") };
    return { ok: false };
}
const VALUE_FLAGS = new Set(["agent", "provider", "model", "reasoning", "decision-depth", "tools", "exclude-tools", "timeout", "max-turns", "budget"]);
const BOOLEAN_FLAGS = new Set(["detach", "no-open", "no-session", "offline"]);
const REASONING = new Set(REASONING_LEVELS);
const DECISION_DEPTH = new Set(["focused", "standard", "deep"]);
const PER_ROLE = /^(navigator|explorer|crewmate|surveyor)[:=]/i;
function positiveInteger(value, max) {
    if (!/^[1-9][0-9]*$/.test(value))
        return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed <= max ? parsed : undefined;
}
function toolList(value) {
    const tools = value.split(",");
    return tools.length <= 64 && tools.every((tool) => /^[A-Za-z0-9_.:/-]{1,128}$/.test(tool)) && new Set(tools).size === tools.length
        ? tools
        : undefined;
}
/** Parse `start` and the bounded, credential-free shared override set. */
export function parseStartArgs(args) {
    if (args.length === 0)
        return { ok: false };
    const [command, ...flags] = args;
    if (command !== "start")
        return { ok: false };
    const values = new Map();
    for (let index = 0; index < flags.length; index += 1) {
        const raw = flags[index];
        if (!raw.startsWith("--"))
            return { ok: false };
        const eq = raw.indexOf("=");
        const name = raw.slice(2, eq === -1 ? undefined : eq);
        if (/key|secret|token|credential|password/i.test(name))
            return { ok: false };
        if ((!VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name)) || values.has(name))
            return { ok: false };
        if (BOOLEAN_FLAGS.has(name)) {
            if (eq !== -1)
                return { ok: false };
            values.set(name, true);
            continue;
        }
        const value = eq === -1 ? flags[++index] : raw.slice(eq + 1);
        if (!value || value.length > 256 || !/^[\x21-\x7e]+$/.test(value) || value.startsWith("--") || PER_ROLE.test(value))
            return { ok: false };
        values.set(name, value);
    }
    const reasoning = values.get("reasoning");
    const decisionDepth = values.get("decision-depth");
    const tools = typeof values.get("tools") === "string" ? toolList(values.get("tools")) : undefined;
    const excludedTools = typeof values.get("exclude-tools") === "string" ? toolList(values.get("exclude-tools")) : undefined;
    const timeoutMs = typeof values.get("timeout") === "string" ? positiveInteger(values.get("timeout"), 2_100_000) : undefined;
    const maxTurns = typeof values.get("max-turns") === "string" ? positiveInteger(values.get("max-turns"), 20) : undefined;
    const budget = typeof values.get("budget") === "string" ? positiveInteger(values.get("budget"), Number.MAX_SAFE_INTEGER) : undefined;
    if ((reasoning !== undefined && (typeof reasoning !== "string" || !REASONING.has(reasoning))) || (decisionDepth !== undefined && (typeof decisionDepth !== "string" || !DECISION_DEPTH.has(decisionDepth))) || (values.has("tools") && !tools) || (values.has("exclude-tools") && !excludedTools) || (tools && excludedTools && tools.some((tool) => excludedTools.includes(tool))) || (values.has("timeout") && !timeoutMs) || (values.has("max-turns") && !maxTurns) || (values.has("budget") && !budget))
        return { ok: false };
    return {
        ok: true,
        detach: values.has("detach"),
        noOpen: values.has("no-open"),
        overrides: {
            ...(typeof values.get("agent") === "string" ? { agentRef: values.get("agent") } : {}),
            ...(typeof values.get("provider") === "string" ? { provider: values.get("provider") } : {}),
            ...(typeof values.get("model") === "string" ? { model: values.get("model") } : {}),
            ...(typeof reasoning === "string" ? { reasoning } : {}),
            ...(typeof decisionDepth === "string" ? { decisionDepth: decisionDepth } : {}),
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
/** Start the standalone validator as a detached process so its state is not agent-writable. */
export function defaultLaunchFocusGuard(requestPath, cwd, spawnFn = spawn) {
    const child = spawnFn(process.execPath, [fileURLToPath(import.meta.url), "focus", "guard", "--request", requestPath], {
        cwd,
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { ...process.env, [FOCUS_GUARD_CHILD]: "1" },
    });
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            child.removeAllListeners();
            if (child.connected)
                child.disconnect();
            child.unref();
            if (error)
                reject(error);
            else
                resolve(result);
        };
        const timeout = setTimeout(() => {
            child.kill();
            finish(new Error("focus guard did not become ready"));
        }, 10_000);
        timeout.unref();
        child.once("error", (error) => finish(error));
        child.once("exit", (code) => finish(new Error(`focus guard exited before ready (${code ?? "signal"})`)));
        child.on("message", (message) => {
            if (typeof message !== "object" || message === null || message.type !== "bearing-focus-ready")
                return;
            const result = message.result;
            if (result && typeof result === "object" && typeof result.ok === "boolean")
                finish(undefined, result);
        });
    });
}
/** Start a platform-neutral detached copy and wait until it reports its URL. */
export function defaultLaunchDetached(args, spawnFn = spawn) {
    const child = spawnFn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { ...process.env, [DETACHED_CHILD]: "1" },
    });
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, url) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            child.removeAllListeners();
            child.unref();
            if (error)
                reject(error);
            else
                resolve(url);
        };
        const timeout = setTimeout(() => {
            child.kill();
            finish(new Error("detached launch did not become ready"));
        }, 10_000);
        timeout.unref();
        child.once("error", (error) => finish(error));
        child.once("exit", (code) => finish(new Error(`detached launch exited before ready (${code ?? "signal"})`)));
        child.on("message", (message) => {
            if (typeof message !== "object" || message === null)
                return;
            const result = message;
            if (result.type === "bearing-ready" && typeof result.url === "string")
                finish(undefined, result.url);
            else if (result.type === "bearing-error")
                finish(new Error(result.error ?? "detached launch failed"));
        });
    });
}
// ponytail: injected seam only so opener-error safety is testable without a real browser.
export function defaultOpenBrowser(url, spawnFn = spawn) {
    const platform = process.platform;
    let cmd;
    let args;
    if (platform === "darwin") {
        cmd = "open";
        args = [url];
    }
    else if (platform === "win32") {
        cmd = "cmd";
        args = ["/c", "start", "", url];
    }
    else {
        cmd = "xdg-open";
        args = [url];
    }
    try {
        const child = spawnFn(cmd, args, { stdio: "ignore", detached: true });
        // A missing executable emits an async `error` (ENOENT), not a sync throw;
        // attach a listener so an absent opener cannot crash Bearing.
        child.on("error", () => { });
        child.unref();
    }
    catch {
        // Best-effort: browser opening is not a launch requirement.
    }
}
/**
 * Run the launcher. On success resolves to the listening loopback `Server`.
 * On invalid arguments, writes usage to stderr, calls `exit(2)`, and resolves
 * to `undefined`. The browser opener fires exactly once for `start` and never
 * for `start --no-open`.
 */
export function run(args, deps = {}) {
    const openBrowser = deps.openBrowser ?? defaultOpenBrowser;
    const stdout = deps.stdout ?? process.stdout;
    const stderr = deps.stderr ?? process.stderr;
    const exit = deps.exit ?? ((code) => process.exit(code));
    if (process.env[FOCUS_GUARD_CHILD] === "1" && args[0] === "focus" && args[1] === "guard" && args[2] === "--request" && args.length === 4) {
        return beginStandaloneFocus(deps.cwd ?? process.cwd(), args[3]).then((result) => {
            process.send?.({ type: "bearing-focus-ready", result });
            process.disconnect?.();
            if (!result.ok)
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
            if (!result.ok)
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
    return new Promise((resolve, reject) => {
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
            if (!parsed.noOpen)
                openBrowser(url);
            deps.notifyReady?.(url);
            resolve(server);
        });
    });
}
function main(argv) {
    const detachedChild = process.env[DETACHED_CHILD] === "1" && typeof process.send === "function";
    const deps = detachedChild ? {
        stdout: { write: () => true },
        notifyReady: (url) => {
            process.send?.({ type: "bearing-ready", url }, () => process.disconnect());
        },
    } : {};
    run(argv, deps).catch((err) => {
        if (detachedChild) {
            process.send?.({ type: "bearing-error", error: String(err) }, () => process.disconnect());
        }
        process.stderr.write(`bearing: ${String(err)}\n`);
        process.exit(1);
    });
}
export function isDirectInvocation(executablePath = process.argv[1]) {
    if (!executablePath)
        return false;
    try {
        return import.meta.url === pathToFileURL(realpathSync(executablePath)).href;
    }
    catch {
        return false;
    }
}
if (isDirectInvocation())
    main(process.argv.slice(2));
