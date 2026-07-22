import { afterEach, describe, expect, it } from "vitest";
import { get } from "node:http";
import type { Server } from "node:http";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LauncherDeps } from "../src/cli";
import { defaultOpenBrowser, isDirectInvocation, parseStartArgs, run } from "../src/cli";

function newCtx() {
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  const state: { exitCode?: number } = {};
  const d: Required<LauncherDeps> = {
    openBrowser: (url: string) => {
      opened.push(url);
    },
    stdout: { write: (s: string) => { out.push(s); return true; } },
    stderr: { write: (s: string) => { err.push(s); return true; } },
    exit: (code: number) => {
      state.exitCode = code;
    },
  };
  return { d, out, err, opened, getExitCode: () => state.exitCode };
}

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("direct invocation", () => {
  it("recognizes a symlinked executable target but not an unrelated path", async () => {
    const root = await mkdtemp(join(tmpdir(), "bearing-cli-"));
    roots.push(root);
    const executable = join(root, "bearing");
    await symlink(fileURLToPath(new URL("../src/cli.ts", import.meta.url)), executable);

    expect(isDirectInvocation(executable)).toBe(true);
    expect(isDirectInvocation(fileURLToPath(import.meta.url))).toBe(false);
  });
});

describe("parseStartArgs", () => {
  it("accepts `start`", () => {
    expect(parseStartArgs(["start"])).toEqual({ ok: true, detach: false, noOpen: false, overrides: {} });
  });

  it("accepts `start --no-open`", () => {
    expect(parseStartArgs(["start", "--no-open"])).toEqual({ ok: true, detach: false, noOpen: true, overrides: {} });
  });

  it("accepts `start --detach`", () => {
    expect(parseStartArgs(["start", "--detach"])).toEqual({ ok: true, detach: true, noOpen: false, overrides: {} });
  });

  it("parses every approved shared override in spaced and equals forms", () => {
    expect(parseStartArgs(["start", "--agent", "bear", "--provider=codex", "--model", "gpt-5.6-sol", "--reasoning=medium", "--tools", "read,search", "--exclude-tools=write", "--no-session", "--offline", "--timeout=600000", "--max-turns", "7", "--budget=900"])).toEqual({
      ok: true,
      detach: false,
      noOpen: false,
      overrides: { agentRef: "bear", provider: "codex", model: "gpt-5.6-sol", reasoning: "medium", tools: ["read", "search"], excludedTools: ["write"], noSession: true, offline: true, timeoutMs: 600000, maxTurns: 7, budget: { tokens: 900 } },
    });
  });

  it("accepts only approved decision depths", () => {
    expect(parseStartArgs(["start", "--decision-depth", "deep"])).toMatchObject({ ok: true, overrides: { decisionDepth: "deep" } });
    expect(parseStartArgs(["start", "--decision-depth", "medium"]).ok).toBe(false);
  });

  it("accepts provider-native reasoning overrides", () => {
    expect(parseStartArgs(["start", "--reasoning", "max"])).toMatchObject({ ok: true, overrides: { reasoning: "max" } });
    expect(parseStartArgs(["start", "--reasoning", "thinking"])).toMatchObject({ ok: true, overrides: { reasoning: "thinking" } });
  });

  it("accepts an optional safe-integer budget and rejects unsafe values", () => {
    expect(parseStartArgs(["start", "--budget", "9007199254740991"])).toMatchObject({ ok: true, overrides: { budget: { tokens: Number.MAX_SAFE_INTEGER } } });
    expect(parseStartArgs(["start", "--budget", "9007199254740992"]).ok).toBe(false);
  });

  it("rejects duplicate, credential, per-role, malformed, and unsafe overrides", () => {
    for (const args of [
      ["start", "--model", "a", "--model=b"],
      ["start", "--api-key", "secret"],
      ["start", "--model", "navigator=one"],
      ["start", "--tools", "read,,write"],
      ["start", "--exclude-tools", "read,read"],
      ["start", "--tools", "read,write", "--exclude-tools", "write"],
      ["start", "--reasoning", "maximum"],
      ["start", "--timeout", "0"],
      ["start", "--timeout", "2100001"],
      ["start", "--max-turns=-1"],
      ["start", "--budget", "9007199254740992"],
      ["start", "--provider"],
      ["start", "--offline=true"],
      ["start", "--agent", "x".repeat(257)],
    ]) expect(parseStartArgs(args).ok).toBe(false);
  });

  it("rejects an unknown command", () => {
    expect(parseStartArgs(["bogus"]).ok).toBe(false);
  });

  it("rejects an unknown flag", () => {
    expect(parseStartArgs(["start", "--evil"]).ok).toBe(false);
  });

  it("rejects empty input", () => {
    expect(parseStartArgs([]).ok).toBe(false);
  });
});

describe("run launcher", () => {
  it("detaches through the portable child launcher and prints its URL", async () => {
    const ctx = newCtx();
    const launched: string[][] = [];
    const server = await run(["start", "--detach", "--no-open"], {
      ...ctx.d,
      launchDetached: async (args) => {
        launched.push(args);
        return "http://127.0.0.1:43210/#cap=abc123";
      },
    });

    expect(server).toBeUndefined();
    expect(launched).toEqual([["start", "--no-open"]]);
    expect(ctx.out).toEqual(["http://127.0.0.1:43210/#cap=abc123\n"]);
    expect(ctx.opened).toEqual([]);
  });

  it("binds loopback, prints the URL, and opens the browser exactly once", async () => {
    const ctx = newCtx();
    const server = await run(["start"], ctx.d);
    if (!server) throw new Error("expected a listening server");
    servers.push(server);

    const url = ctx.out.join("").trim();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#cap=[0-9a-f]+$/);
    expect(ctx.getExitCode()).toBeUndefined();
    expect(ctx.opened).toEqual([url]);

    const addr = server.address();
    expect(addr).toMatchObject({ address: "127.0.0.1" });
    expect(typeof (addr as { port: number }).port).toBe("number");
    expect((addr as { port: number }).port).toBeGreaterThan(0);
  });

  it("`start --no-open` prints the URL but never opens a browser", async () => {
    const ctx = newCtx();
    const server = await run(["start", "--no-open"], ctx.d);
    if (!server) throw new Error("expected a listening server");
    servers.push(server);

    expect(ctx.opened).toEqual([]);
    expect(ctx.out.join("")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#cap=[0-9a-f]+\n$/);
  });

  it("serves the native HTML placeholder over loopback HTTP", async () => {
    const ctx = newCtx();
    const server = await run(["start", "--no-open"], ctx.d);
    if (!server) throw new Error("expected a listening server");
    servers.push(server);

    const url = new URL(ctx.out.join("").trim());
    const body = await new Promise<string>((resolve, reject) => {
      get(url, (res) => {
        let b = "";
        res.setEncoding("utf-8");
        res.on("data", (c: string) => (b += c));
        res.on("end", () => resolve(b));
      }).on("error", reject);
    });
    expect(body).toContain("<title>Bearing</title>");
  });

  it("rejects an unknown command with a nonzero exit and usage on stderr", async () => {
    const ctx = newCtx();
    const server = await run(["bogus"], ctx.d);
    expect(server).toBeUndefined();
    expect(ctx.getExitCode()).toBe(2);
    expect(ctx.err.join("")).toMatch(/usage/);
  });

  it("rejects an unknown flag with a nonzero exit", async () => {
    const ctx = newCtx();
    const server = await run(["start", "--evil"], ctx.d);
    expect(server).toBeUndefined();
    expect(ctx.getExitCode()).toBe(2);
  });
});

describe("defaultOpenBrowser error safety", () => {
  it("absorbs an async spawn error so a missing opener cannot crash Bearing", () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    let unrefed = false;
    (child as { unref(): void }).unref = () => {
      unrefed = true;
    };
    const spawnFn = () => child;

    expect(() => defaultOpenBrowser("http://127.0.0.1:1/", spawnFn)).not.toThrow();
    expect(unrefed).toBe(true);
    // Emitting `error` throws on an EventEmitter with no listener; the attached
    // listener must absorb it. This fails the moment the `.on("error")` guard is removed.
    expect(() => child.emit("error", new Error("spawn ENOENT"))).not.toThrow();
  });
});
