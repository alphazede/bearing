import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodePickerProcessRunner, RepositoryChoiceService, type PickerProcessResult, type PickerProcessRunner } from "../src/repository/choice.js";

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
    expect((await new RepositoryChoiceService({ launchCwd: nested, platform: "linux", runner: new FakeRunner(new Set()), readLinuxRelease: async () => undefined }).options()).current).toEqual({ path: git, source: "git-root" });
    const cwd = await plainRoot();
    expect((await new RepositoryChoiceService({ launchCwd: cwd, platform: "linux", runner: new FakeRunner(new Set()), readLinuxRelease: async () => undefined }).options()).current).toEqual({ path: cwd, source: "cwd" });
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
      expect((await new RepositoryChoiceService({ launchCwd: cwd, platform, runner }).resolve("browse")).result).toBe("selected");
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
      expect((await service.resolve("browse")).result).toBe(result);
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
