import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodePickerProcessRunner, RepositoryChoiceService, type PickerProcessResult, type PickerProcessRunner } from "../src/repository/choice.js";
import { resolveBearingCli } from "../src/repository/executable-path.js";

const roots: string[] = [];
const originalPath = process.env.PATH;
afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(prefix = "bearing-choice-"): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix)); roots.push(value); return value;
}
async function plainRoot(): Promise<string> {
  const value = await mkdtemp(join("/dev/shm", "bearing-choice-")); roots.push(value); return value;
}

class FakeRunner implements PickerProcessRunner {
  readonly calls: { executable: string; args: readonly string[]; cwd: string; timeoutMs: number; maxOutputBytes: number }[] = [];
  constructor(readonly executables: ReadonlySet<string>, private readonly result: PickerProcessResult = { exitCode: 0, stdout: "/tmp/repository\n" }) {}
  available(executable: string): boolean { return this.executables.has(executable); }
  async run(executable: string, args: readonly string[], cwd: string, timeoutMs: number, maxOutputBytes: number): Promise<PickerProcessResult> {
    this.calls.push({ executable, args, cwd, timeoutMs, maxOutputBytes }); return this.result;
  }
}

describe("RepositoryChoiceService", () => {
  it("discovers the nearest Git root and otherwise falls back to launch cwd", async () => {
    const git = await root(); await mkdir(join(git, ".git")); const nested = join(git, "a", "b"); await mkdir(nested, { recursive: true });
    const gitOptions = await new RepositoryChoiceService({ launchCwd: nested, platform: "linux", runner: new FakeRunner(new Set()), readLinuxRelease: async () => undefined }).options();
    if ("unavailable" in gitOptions) throw new Error("expected Git repository options");
    expect(gitOptions.current).toEqual({ path: git, source: "git-root", isGitRoot: true });
    const cwd = await plainRoot();
    const cwdOptions = await new RepositoryChoiceService({ launchCwd: cwd, platform: "linux", runner: new FakeRunner(new Set()), readLinuxRelease: async () => undefined }).options();
    if ("unavailable" in cwdOptions) throw new Error("expected cwd repository options");
    expect(cwdOptions.current).toEqual({ path: cwd, source: "cwd", isGitRoot: false });
  });

  it("surfaces an unavailable launch cwd without rejecting", async () => {
    const cwd = await root(); await rm(cwd, { recursive: true });
    const service = new RepositoryChoiceService({ launchCwd: cwd, platform: "linux", runner: new FakeRunner(new Set()) });
    await expect(service.options()).resolves.toEqual({ unavailable: "launch_cwd_unavailable" });
    await expect(service.resolve("current")).resolves.toEqual({ unavailable: "launch_cwd_unavailable" });
  });

  it("exposes the injected known-agent realpaths", () => {
    const paths = ["/opt/agents/codex", "/opt/agents/claude"] as const;
    const service = new RepositoryChoiceService({ agentExecutableRealpaths: () => paths });
    expect(service.agentExecutableRealpaths()).toBe(paths);
  });

  it("reports display-only platform, bounded distro, and picker capability", async () => {
    const cwd = await plainRoot();
    const options = await new RepositoryChoiceService({ launchCwd: cwd, platform: "linux", runner: new FakeRunner(new Set(["kdialog"])), readLinuxRelease: async () => 'NAME="Test Linux"\nPRETTY_NAME="Test Linux 1"\n' }).options();
    expect(options).toMatchObject({ platform: "linux", linuxDistro: "Test Linux 1", browse: { available: true, picker: "kdialog" } });
    expect(await new RepositoryChoiceService({ launchCwd: cwd, platform: "freebsd", runner: new FakeRunner(new Set()) }).options()).toMatchObject({ platform: "other-unix", browse: { available: false } });
  });

  it("uses only the fixed platform commands and prefers zenity on Linux", async () => {
    const cwd = await root();
    const cases = [
      ["win32", new Set(["powershell.exe"]), "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }"]],
      ["darwin", new Set(["osascript"]), "osascript", ["-e", 'POSIX path of (choose folder with prompt "Choose a repository")']],
      ["linux", new Set(["zenity", "kdialog"]), "zenity", ["--file-selection", "--directory", "--title=Bearing: Choose repository"]],
      ["linux", new Set(["kdialog"]), "kdialog", ["--getexistingdirectory", ".", "--title", "Bearing: Choose repository"]],
    ] as const;
    for (const [platform, available, executable, args] of cases) {
      const output = platform === "win32" ? "C:\\work\\repo\r\n" : "/tmp/repository\n";
      const runner = new FakeRunner(available, { exitCode: 0, stdout: output });
      const resolved = await new RepositoryChoiceService({ launchCwd: cwd, platform, runner }).resolve("browse");
      if ("unavailable" in resolved) throw new Error("expected picker result");
      expect(resolved.result).toBe("selected");
      expect(runner.calls[0]).toMatchObject({ executable, timeoutMs: 300_000, maxOutputBytes: 4096 });
      expect(runner.calls[0].args).toEqual([...args]);
    }
  });

  it("emits bounded redacted discovery and picker diagnostics only", async () => {
    const cwd = await mkdtemp(join("/dev/shm", "SECRET_PATH-")); roots.push(cwd);
    const diagnostics: unknown[] = [];
    const runner = new FakeRunner(new Set(["zenity"]), { exitCode: 0, stdout: `${cwd}/SECRET_OUTPUT\n` });
    const service = new RepositoryChoiceService({ launchCwd: cwd, platform: "linux", runner, readLinuxRelease: async () => 'PRETTY_NAME="SECRET_DISTRO"', diagnosticSink: (diagnostic) => diagnostics.push(diagnostic) });
    await service.options();
    await service.resolve("browse");
    expect(diagnostics).toEqual(expect.arrayContaining([
      { event: "repository_discovery", platform: "linux", source: "cwd" },
      expect.objectContaining({ event: "repository_picker", platform: "linux", picker: "zenity", result: "selected", durationMs: expect.any(Number) }),
    ]));
    const picker = diagnostics.at(-1) as { durationMs: number };
    expect(Number.isSafeInteger(picker.durationMs)).toBe(true);
    expect(picker.durationMs).toBeGreaterThanOrEqual(0);
    expect(picker.durationMs).toBeLessThanOrEqual(300_500);
    expect(JSON.stringify(diagnostics)).not.toMatch(/SECRET_PATH|SECRET_OUTPUT|SECRET_DISTRO|\/dev\/shm|stdout|stderr|command|candidate|linuxDistro/);
  });

  it("keeps current usable and classifies unavailable, cancel, timeout, and hostile output", async () => {
    const cwd = await plainRoot();
    const unavailable = new RepositoryChoiceService({ launchCwd: cwd, platform: "linux", runner: new FakeRunner(new Set()) });
    expect(await unavailable.resolve("current")).toMatchObject({ result: "selected", candidate: cwd, source: "cwd" });
    expect(await unavailable.resolve("browse")).toEqual({ result: "unavailable" });
    for (const [processResult, result] of [
      [{ exitCode: 1, stdout: "" }, "cancelled"],
      [{ timedOut: true }, "timeout"],
      [{ overflow: true }, "invalid"],
      [{ exitCode: 0, stdout: "/tmp/a\n/tmp/b\n" }, "invalid"],
      [{ exitCode: 0, stdout: "/tmp/a\0evil" }, "invalid"],
      [{ exitCode: 0, stdout: "relative/path" }, "invalid"],
      [{ exitCode: 0, stdout: "x".repeat(4097) }, "invalid"],
    ] as const) {
      const service = new RepositoryChoiceService({ launchCwd: cwd, platform: "linux", runner: new FakeRunner(new Set(["zenity"]), processResult) });
      const resolved = await service.resolve("browse");
      if ("unavailable" in resolved) throw new Error("expected classified picker result");
      expect(resolved.result).toBe(result);
    }
  });
});

describe("NodePickerProcessRunner", () => {
  it("resolves only absolute PATH entries and bounds output and runtime without a shell", async () => {
    const bin = await root("bearing-picker-bin-"); await symlink(process.execPath, join(bin, "fake-picker")); process.env.PATH = bin;
    const runner = new NodePickerProcessRunner();
    expect(runner.available("fake-picker")).toBe(true);
    expect(await runner.run("fake-picker", ["-e", "process.stdout.write('x'.repeat(100))"], bin, 1000, 8)).toMatchObject({ overflow: true });
    expect(await runner.run("fake-picker", ["-e", "setInterval(function(){},1000)"], bin, 5, 8)).toMatchObject({ timedOut: true });
    process.env.PATH = `relative${process.platform === "win32" ? ";" : ":"}${bin}`;
    expect(runner.available("fake-picker")).toBe(true);
  });

  it("force-kills a real child that ignores SIGTERM before resolving timeout", async () => {
    const bin = await root("bearing-picker-bin-"); await symlink(process.execPath, join(bin, "fake-picker")); process.env.PATH = bin;
    const pidFile = join(bin, "child.pid");
    const runner = new NodePickerProcessRunner();
    const pending = runner.run("fake-picker", ["-e", "process.on('SIGTERM',function(){});require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(function(){},1000)", pidFile], bin, 200, 8);
    const result = await Promise.race([pending, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("picker test hung")), 2000))]);
    expect(result).toMatchObject({ timedOut: true });
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(Number.isInteger(pid)).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 3000);
});

describe("resolveBearingCli (version- and provenance-aware)", () => {
  it("selects bundled (0.1.6) over older PATH executable (0.1.5) with runtime_version_mismatch and reports both", async () => {
    // create older PATH candidate fixture with matching layout <root>/package.json + <root>/dist/cli.js
    const olderRoot = await root("bearing-older-pkg-");
    await writeFile(join(olderRoot, "package.json"), `${JSON.stringify({ name: "@alphazede/bearing", version: "0.1.5" })}\n`);
    const olderDist = join(olderRoot, "dist");
    await mkdir(olderDist, { recursive: true });
    const olderCli = join(olderDist, "cli.js");
    await writeFile(olderCli, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ok:true}));", { mode: 0o755 });
    const olderBin = await root("bearing-older-bin-");
    await symlink(olderCli, join(olderBin, "bearing"));
    const savedPath = process.env.PATH;
    process.env.PATH = olderBin;
    try {
      const res = resolveBearingCli();
      expect(res.source).toBe("bundled");
      expect(res.reason).toBe("runtime_version_mismatch");
      expect(res.version).toBe("0.1.6");
      expect(res.bundled).toEqual({ path: expect.any(String), version: "0.1.6" });
      expect(res.pathCandidate).toEqual({ path: expect.any(String), version: "0.1.5" });
      // effective uses bundled
      expect(res.path).toBe(res.bundled.path);
      // bundled path comes from self (src/cli.ts under test loader or dist/cli.js)
      expect(res.bundled.path).toMatch(/cli\.(js|ts)$/);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("selects PATH candidate when provenance matches and version >= bundled (preserves PATH-first only on proven compatibility)", async () => {
    const compatRoot = await root("bearing-compat-pkg-");
    await writeFile(join(compatRoot, "package.json"), `${JSON.stringify({ name: "@alphazede/bearing", version: "0.1.7" })}\n`);
    const compatDist = join(compatRoot, "dist");
    await mkdir(compatDist, { recursive: true });
    const compatCli = join(compatDist, "cli.js");
    await writeFile(compatCli, "#!/usr/bin/env node\n", { mode: 0o755 });
    const compatBin = await root("bearing-compat-bin-");
    await symlink(compatCli, join(compatBin, "bearing"));
    const savedPath = process.env.PATH;
    process.env.PATH = compatBin;
    try {
      const res = resolveBearingCli();
      expect(res.source).toBe("path");
      expect(res.version).toBe("0.1.7");
      expect(res.reason).toMatch(/preferred|path/);
      expect(res.path).toBe(compatCli);
      expect(res.pathCandidate?.version).toBe("0.1.7");
      expect(res.bundled.version).toBe("0.1.6");
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("selects bundled (1.0.0) over PATH prerelease (1.0.0-beta.1) with runtime_version_mismatch (regression: prerelease must be treated older than same-core stable)", async () => {
    const prereleaseRoot = await root("bearing-prerelease-pkg-");
    await writeFile(join(prereleaseRoot, "package.json"), `${JSON.stringify({ name: "@alphazede/bearing", version: "1.0.0-beta.1" })}\n`);
    const prereleaseDist = join(prereleaseRoot, "dist");
    await mkdir(prereleaseDist, { recursive: true });
    const prereleaseCli = join(prereleaseDist, "cli.js");
    await writeFile(prereleaseCli, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ok:true}));", { mode: 0o755 });
    const prereleaseBin = await root("bearing-prerelease-bin-");
    await symlink(prereleaseCli, join(prereleaseBin, "bearing"));
    const savedPath = process.env.PATH;
    process.env.PATH = prereleaseBin;
    try {
      const res = resolveBearingCli({ bundled: { path: "/bundled/cli.ts", version: "1.0.0" } });
      expect(res.source).toBe("bundled");
      expect(res.reason).toBe("runtime_version_mismatch");
      expect(res.version).toBe("1.0.0");
      expect(res.bundled).toEqual({ path: expect.any(String), version: "1.0.0" });
      expect(res.pathCandidate).toEqual({ path: expect.any(String), version: "1.0.0-beta.1" });
      expect(res.path).toBe(res.bundled.path);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("selects bundled (1.0.0-beta.2) over PATH prerelease (1.0.0-beta.1) with runtime_version_mismatch (regression: prerelease identifier ordering)", async () => {
    const olderPreRoot = await root("bearing-older-pre-pkg-");
    await writeFile(join(olderPreRoot, "package.json"), `${JSON.stringify({ name: "@alphazede/bearing", version: "1.0.0-beta.1" })}\n`);
    const olderPreDist = join(olderPreRoot, "dist");
    await mkdir(olderPreDist, { recursive: true });
    const olderPreCli = join(olderPreDist, "cli.js");
    await writeFile(olderPreCli, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ok:true}));", { mode: 0o755 });
    const olderPreBin = await root("bearing-older-pre-bin-");
    await symlink(olderPreCli, join(olderPreBin, "bearing"));
    const savedPath = process.env.PATH;
    process.env.PATH = olderPreBin;
    try {
      const res = resolveBearingCli({ bundled: { path: "/bundled/cli.ts", version: "1.0.0-beta.2" } });
      expect(res.source).toBe("bundled");
      expect(res.reason).toBe("runtime_version_mismatch");
      expect(res.version).toBe("1.0.0-beta.2");
      expect(res.pathCandidate).toEqual({ path: expect.any(String), version: "1.0.0-beta.1" });
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("selects bundled (1.0.0-alpha.beta) over PATH (1.0.0-alpha.1) with runtime_version_mismatch (regression: numeric identifier has lower precedence than non-numeric)", async () => {
    const mixedRoot = await root("bearing-mixed-pre-pkg-");
    await writeFile(join(mixedRoot, "package.json"), `${JSON.stringify({ name: "@alphazede/bearing", version: "1.0.0-alpha.1" })}\n`);
    const mixedDist = join(mixedRoot, "dist");
    await mkdir(mixedDist, { recursive: true });
    const mixedCli = join(mixedDist, "cli.js");
    await writeFile(mixedCli, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ok:true}));", { mode: 0o755 });
    const mixedBin = await root("bearing-mixed-pre-bin-");
    await symlink(mixedCli, join(mixedBin, "bearing"));
    const savedPath = process.env.PATH;
    process.env.PATH = mixedBin;
    try {
      const res = resolveBearingCli({ bundled: { path: "/bundled/cli.ts", version: "1.0.0-alpha.beta" } });
      expect(res.source).toBe("bundled");
      expect(res.reason).toBe("runtime_version_mismatch");
      expect(res.version).toBe("1.0.0-alpha.beta");
      expect(res.pathCandidate).toEqual({ path: expect.any(String), version: "1.0.0-alpha.1" });
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("selects bundled (1.0.0-9007199254740993) over PATH (1.0.0-9007199254740992) with runtime_version_mismatch (regression: numeric identifiers beyond Number.MAX_SAFE_INTEGER must not compare equal)", async () => {
    const bignumRoot = await root("bearing-bignum-pre-pkg-");
    await writeFile(join(bignumRoot, "package.json"), `${JSON.stringify({ name: "@alphazede/bearing", version: "1.0.0-9007199254740992" })}\n`);
    const bignumDist = join(bignumRoot, "dist");
    await mkdir(bignumDist, { recursive: true });
    const bignumCli = join(bignumDist, "cli.js");
    await writeFile(bignumCli, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ok:true}));", { mode: 0o755 });
    const bignumBin = await root("bearing-bignum-pre-bin-");
    await symlink(bignumCli, join(bignumBin, "bearing"));
    const savedPath = process.env.PATH;
    process.env.PATH = bignumBin;
    try {
      const res = resolveBearingCli({ bundled: { path: "/bundled/cli.ts", version: "1.0.0-9007199254740993" } });
      expect(res.source).toBe("bundled");
      expect(res.reason).toBe("runtime_version_mismatch");
      expect(res.version).toBe("1.0.0-9007199254740993");
      expect(res.pathCandidate).toEqual({ path: expect.any(String), version: "1.0.0-9007199254740992" });
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("selects bundled (1.0.0-100) over PATH (1.0.0-99) with runtime_version_mismatch (regression: numeric identifier ordering is by digit-string length/value, not lexical/shorter-prefix comparison)", async () => {
    const prefixRoot = await root("bearing-prefix-pre-pkg-");
    await writeFile(join(prefixRoot, "package.json"), `${JSON.stringify({ name: "@alphazede/bearing", version: "1.0.0-99" })}\n`);
    const prefixDist = join(prefixRoot, "dist");
    await mkdir(prefixDist, { recursive: true });
    const prefixCli = join(prefixDist, "cli.js");
    await writeFile(prefixCli, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ok:true}));", { mode: 0o755 });
    const prefixBin = await root("bearing-prefix-pre-bin-");
    await symlink(prefixCli, join(prefixBin, "bearing"));
    const savedPath = process.env.PATH;
    process.env.PATH = prefixBin;
    try {
      const res = resolveBearingCli({ bundled: { path: "/bundled/cli.ts", version: "1.0.0-100" } });
      expect(res.source).toBe("bundled");
      expect(res.reason).toBe("runtime_version_mismatch");
      expect(res.version).toBe("1.0.0-100");
      expect(res.pathCandidate).toEqual({ path: expect.any(String), version: "1.0.0-99" });
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("resolves the canonical SemVer 2.0.0 precedence chain in order via bundled-vs-PATH comparisons (1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta < 1.0.0-beta.2 < 1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0)", async () => {
    const chain = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (let i = 0; i < chain.length - 1; i++) {
      const low = chain[i];
      const high = chain[i + 1];
      const preRoot = await root(`bearing-prechain-${i}-`);
      await writeFile(join(preRoot, "package.json"), `${JSON.stringify({ name: "@alphazede/bearing", version: low })}\n`);
      const preDist = join(preRoot, "dist");
      await mkdir(preDist, { recursive: true });
      const preCli = join(preDist, "cli.js");
      await writeFile(preCli, "#!/usr/bin/env node\n", { mode: 0o755 });
      const preBin = await root(`bearing-prechain-bin-${i}-`);
      await symlink(preCli, join(preBin, "bearing"));
      const savedPath = process.env.PATH;
      process.env.PATH = preBin;
      try {
        const res = resolveBearingCli({ bundled: { path: "/bundled/cli.ts", version: high } });
        expect(res.source).toBe("bundled");
        expect(res.reason).toBe("runtime_version_mismatch");
        expect(res.version).toBe(high);
        expect(res.pathCandidate).toEqual({ path: expect.any(String), version: low });
      } finally {
        process.env.PATH = savedPath;
      }
    }
  });

  it("parses versions containing build metadata (+...) successfully, ignores build metadata for precedence (SemVer §10), and correctly selects bundled with +build over older PATH", async () => {
    // bundled 1.0.0+build.1 vs PATH 0.9.0 => bundled wins (build parses, does not block, and 0.9.0 is older)
    const oldRoot = await root("bearing-old-build-pkg-");
    await writeFile(join(oldRoot, "package.json"), `${JSON.stringify({ name: "@alphazede/bearing", version: "0.9.0" })}\n`);
    const oldDist = join(oldRoot, "dist");
    await mkdir(oldDist, { recursive: true });
    const oldCli = join(oldDist, "cli.js");
    await writeFile(oldCli, "#!/usr/bin/env node\n", { mode: 0o755 });
    const oldBin = await root("bearing-old-build-bin-");
    await symlink(oldCli, join(oldBin, "bearing"));
    let savedPath = process.env.PATH;
    process.env.PATH = oldBin;
    try {
      const res = resolveBearingCli({ bundled: { path: "/bundled/cli.ts", version: "1.0.0+build.1" } });
      expect(res.source).toBe("bundled");
      expect(res.reason).toBe("runtime_version_mismatch");
      expect(res.version).toBe("1.0.0+build.1");
      expect(res.pathCandidate).toEqual({ path: expect.any(String), version: "0.9.0" });
    } finally {
      process.env.PATH = savedPath;
    }

    // two versions differing only in build metadata have equal precedence: neither is older than the other
    // (PATH selected means !isOlder(pathVer, bundledVer))
    const b2Root = await root("bearing-build2-pkg-");
    await writeFile(join(b2Root, "package.json"), `${JSON.stringify({ name: "@alphazede/bearing", version: "1.0.0+build.2" })}\n`);
    const b2Dist = join(b2Root, "dist");
    await mkdir(b2Dist, { recursive: true });
    const b2Cli = join(b2Dist, "cli.js");
    await writeFile(b2Cli, "#!/usr/bin/env node\n", { mode: 0o755 });
    const b2Bin = await root("bearing-build2-bin-");
    await symlink(b2Cli, join(b2Bin, "bearing"));
    savedPath = process.env.PATH;
    process.env.PATH = b2Bin;
    try {
      const res = resolveBearingCli({ bundled: { path: "/bundled/cli.ts", version: "1.0.0+build.1" } });
      expect(res.source).toBe("path");
      expect(res.version).toBe("1.0.0+build.2");
      expect(res.pathCandidate?.version).toBe("1.0.0+build.2");
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("handles arbitrary-size core numeric identifiers beyond Number.MAX_SAFE_INTEGER using length-then-lexical comparison (no Number/parseInt/BigInt)", async () => {
    const lowCore = "9007199254740992.0.0";
    const highCore = "9007199254740993.0.0";
    const bigRoot = await root("bearing-bigcore-pkg-");
    await writeFile(join(bigRoot, "package.json"), `${JSON.stringify({ name: "@alphazede/bearing", version: lowCore })}\n`);
    const bigDist = join(bigRoot, "dist");
    await mkdir(bigDist, { recursive: true });
    const bigCli = join(bigDist, "cli.js");
    await writeFile(bigCli, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ok:true}));", { mode: 0o755 });
    const bigBin = await root("bearing-bigcore-bin-");
    await symlink(bigCli, join(bigBin, "bearing"));
    const savedPath = process.env.PATH;
    process.env.PATH = bigBin;
    try {
      const res = resolveBearingCli({ bundled: { path: "/bundled/cli.ts", version: highCore } });
      expect(res.source).toBe("bundled");
      expect(res.reason).toBe("runtime_version_mismatch");
      expect(res.version).toBe(highCore);
      expect(res.pathCandidate).toEqual({ path: expect.any(String), version: lowCore });
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("rejects leading-zero numeric identifiers for core and prerelease (invalid per SemVer §9, fail-closed); invalid candidate not preferred over valid (regression)", async () => {
    // prerelease lead-zero: PATH "1.0.0-01" (invalid) must not be preferred over bundled "1.0.0-1"
    const lzPreRoot = await root("bearing-lzpre-pkg-");
    await writeFile(join(lzPreRoot, "package.json"), `${JSON.stringify({ name: "@alphazede/bearing", version: "1.0.0-01" })}\n`);
    const lzPreDist = join(lzPreRoot, "dist");
    await mkdir(lzPreDist, { recursive: true });
    const lzPreCli = join(lzPreDist, "cli.js");
    await writeFile(lzPreCli, "#!/usr/bin/env node\n", { mode: 0o755 });
    const lzPreBin = await root("bearing-lzpre-bin-");
    await symlink(lzPreCli, join(lzPreBin, "bearing"));
    let savedPath = process.env.PATH;
    process.env.PATH = lzPreBin;
    try {
      const res = resolveBearingCli({ bundled: { path: "/bundled/cli.ts", version: "1.0.0-1" } });
      expect(res.source).toBe("bundled");
      expect(res.reason).toBe("runtime_version_mismatch");
      expect(res.pathCandidate?.version).toBe("1.0.0-01");
    } finally {
      process.env.PATH = savedPath;
    }

    // core lead-zero: PATH "01.0.0" (invalid) treated older than "1.0.0"
    const lzCoreRoot = await root("bearing-lzcore-pkg-");
    await writeFile(join(lzCoreRoot, "package.json"), `${JSON.stringify({ name: "@alphazede/bearing", version: "01.0.0" })}\n`);
    const lzCoreDist = join(lzCoreRoot, "dist");
    await mkdir(lzCoreDist, { recursive: true });
    const lzCoreCli = join(lzCoreDist, "cli.js");
    await writeFile(lzCoreCli, "#!/usr/bin/env node\n", { mode: 0o755 });
    const lzCoreBin = await root("bearing-lzcore-bin-");
    await symlink(lzCoreCli, join(lzCoreBin, "bearing"));
    savedPath = process.env.PATH;
    process.env.PATH = lzCoreBin;
    try {
      const res = resolveBearingCli({ bundled: { path: "/bundled/cli.ts", version: "1.0.0" } });
      expect(res.source).toBe("bundled");
      expect(res.reason).toBe("runtime_version_mismatch");
      expect(res.pathCandidate?.version).toBe("01.0.0");
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("accepts valid mixed numeric+alphanumeric prerelease identifiers and rejects invalid cases (empty identifier via dot, disallowed char) fail-closed without crashing", async () => {
    // mixed: "1.0.0-1.alpha" (num + alnum) > "1.0.0-1.9" (num + num) because alnum > numeric at that position
    const mixedRoot = await root("bearing-mixpre-pkg-");
    await writeFile(join(mixedRoot, "package.json"), `${JSON.stringify({ name: "@alphazede/bearing", version: "1.0.0-1.9" })}\n`);
    const mixedDist = join(mixedRoot, "dist");
    await mkdir(mixedDist, { recursive: true });
    const mixedCli = join(mixedDist, "cli.js");
    await writeFile(mixedCli, "#!/usr/bin/env node\n", { mode: 0o755 });
    const mixedBin = await root("bearing-mixpre-bin-");
    await symlink(mixedCli, join(mixedBin, "bearing"));
    let savedPath = process.env.PATH;
    process.env.PATH = mixedBin;
    try {
      const res = resolveBearingCli({ bundled: { path: "/bundled/cli.ts", version: "1.0.0-1.alpha" } });
      expect(res.source).toBe("bundled");
      expect(res.reason).toBe("runtime_version_mismatch");
      expect(res.pathCandidate?.version).toBe("1.0.0-1.9");
    } finally {
      process.env.PATH = savedPath;
    }

    // invalid: trailing dot creates empty identifier "1.0.0-1."
    const invDotRoot = await root("bearing-invdot-pkg-");
    await writeFile(join(invDotRoot, "package.json"), `${JSON.stringify({ name: "@alphazede/bearing", version: "1.0.0-1." })}\n`);
    const invDotDist = join(invDotRoot, "dist");
    await mkdir(invDotDist, { recursive: true });
    const invDotCli = join(invDotDist, "cli.js");
    await writeFile(invDotCli, "#!/usr/bin/env node\n", { mode: 0o755 });
    const invDotBin = await root("bearing-invdot-bin-");
    await symlink(invDotCli, join(invDotBin, "bearing"));
    savedPath = process.env.PATH;
    process.env.PATH = invDotBin;
    try {
      const res = resolveBearingCli({ bundled: { path: "/bundled/cli.ts", version: "1.0.0-1" } });
      expect(res.source).toBe("bundled");
      expect(res.reason).toBe("runtime_version_mismatch");
      expect(res.pathCandidate?.version).toBe("1.0.0-1.");
    } finally {
      process.env.PATH = savedPath;
    }

    // invalid: disallowed character "_" in identifier
    const invCharRoot = await root("bearing-invchar-pkg-");
    await writeFile(join(invCharRoot, "package.json"), `${JSON.stringify({ name: "@alphazede/bearing", version: "1.0.0-1_2" })}\n`);
    const invCharDist = join(invCharRoot, "dist");
    await mkdir(invCharDist, { recursive: true });
    const invCharCli = join(invCharDist, "cli.js");
    await writeFile(invCharCli, "#!/usr/bin/env node\n", { mode: 0o755 });
    const invCharBin = await root("bearing-invchar-bin-");
    await symlink(invCharCli, join(invCharBin, "bearing"));
    savedPath = process.env.PATH;
    process.env.PATH = invCharBin;
    try {
      const res = resolveBearingCli({ bundled: { path: "/bundled/cli.ts", version: "1.0.0-1" } });
      expect(res.source).toBe("bundled");
      expect(res.reason).toBe("runtime_version_mismatch");
      expect(res.pathCandidate?.version).toBe("1.0.0-1_2");
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("selects bundled over PATH when bundled version is unparseable (fail-closed provenance: baseline untrusted must not yield path_preferred; regression)", async () => {
    const newerRoot = await root("bearing-newer-pkg-");
    await writeFile(join(newerRoot, "package.json"), `${JSON.stringify({ name: "@alphazede/bearing", version: "2.0.0" })}\n`);
    const newerDist = join(newerRoot, "dist");
    await mkdir(newerDist, { recursive: true });
    const newerCli = join(newerDist, "cli.js");
    await writeFile(newerCli, "#!/usr/bin/env node\n", { mode: 0o755 });
    const newerBin = await root("bearing-newer-bin-");
    await symlink(newerCli, join(newerBin, "bearing"));
    const savedPath = process.env.PATH;
    process.env.PATH = newerBin;
    try {
      const res = resolveBearingCli({ bundled: { path: "/bundled/cli.ts", version: "not-semver" } });
      expect(res.source).toBe("bundled");
      expect(res.reason).toBe("runtime_version_mismatch");
      expect(res.version).toBe("not-semver");
      expect(res.bundled).toEqual({ path: "/bundled/cli.ts", version: "not-semver" });
      expect(res.pathCandidate).toEqual({ path: expect.any(String), version: "2.0.0" });
      expect(res.path).toBe(res.bundled.path);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("selects bundled when PATH candidate version is unparseable (invalid-PATH/valid-bundled unaffected; no regression on candidate failure path)", async () => {
    const badRoot = await root("bearing-badver-pkg-");
    await writeFile(join(badRoot, "package.json"), `${JSON.stringify({ name: "@alphazede/bearing", version: "not-semver" })}\n`);
    const badDist = join(badRoot, "dist");
    await mkdir(badDist, { recursive: true });
    const badCli = join(badDist, "cli.js");
    await writeFile(badCli, "#!/usr/bin/env node\n", { mode: 0o755 });
    const badBin = await root("bearing-badver-bin-");
    await symlink(badCli, join(badBin, "bearing"));
    const savedPath = process.env.PATH;
    process.env.PATH = badBin;
    try {
      const res = resolveBearingCli({ bundled: { path: "/bundled/cli.ts", version: "1.0.0" } });
      expect(res.source).toBe("bundled");
      expect(res.reason).toBe("runtime_version_mismatch");
      expect(res.pathCandidate?.version).toBe("not-semver");
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
