import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, posix, win32 } from "node:path";
const PICKER_TIMEOUT_MS = 300_000;
const MAX_PICKER_OUTPUT = 4 * 1024;
const MAX_DISTRO_FILE = 16 * 1024;
const TERMINATION_GRACE_MS = 100;
const FORCED_CLOSE_WAIT_MS = 500;
const WINDOWS_COMMAND = {
    kind: "powershell",
    executable: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }"],
};
const MAC_COMMAND = {
    kind: "osascript",
    executable: "osascript",
    args: ["-e", 'POSIX path of (choose folder with prompt "Choose a repository")'],
};
const LINUX_COMMANDS = [
    { kind: "zenity", executable: "zenity", args: ["--file-selection", "--directory", "--title=Bearing: Choose repository"] },
    { kind: "kdialog", executable: "kdialog", args: ["--getexistingdirectory", ".", "--title", "Bearing: Choose repository"] },
];
function platformClass(platform) {
    return platform === "win32" || platform === "darwin" || platform === "linux" ? platform : "other-unix";
}
async function currentCandidate(cwd) {
    const canonical = await realpath(cwd);
    let cursor = canonical;
    for (;;) {
        try {
            const marker = await lstat(join(cursor, ".git"));
            if (marker.isDirectory() || marker.isFile())
                return { path: cursor, source: "git-root" };
        }
        catch { /* walk toward the filesystem root */ }
        const parent = dirname(cursor);
        if (parent === cursor)
            return { path: canonical, source: "cwd" };
        cursor = parent;
    }
}
async function defaultLinuxRelease() {
    try {
        const body = await readFile("/etc/os-release", "utf8");
        return Buffer.byteLength(body) <= MAX_DISTRO_FILE ? body : undefined;
    }
    catch {
        return undefined;
    }
}
function distroLabel(body) {
    if (!body)
        return undefined;
    const values = new Map();
    for (const line of body.split(/\r?\n/)) {
        const match = /^([A-Z_]+)=(.*)$/.exec(line);
        if (!match)
            continue;
        const raw = match[2];
        const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1).replace(/\\([\\"$`])/g, "$1") : raw;
        if (value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value))
            values.set(match[1], value);
    }
    return values.get("PRETTY_NAME") ?? values.get("NAME");
}
function resolveExecutable(executable) {
    for (const directory of (process.env.PATH ?? "").split(delimiter).filter(isAbsolute)) {
        try {
            const candidate = join(directory, executable);
            accessSync(candidate, constants.X_OK);
            return realpathSync(candidate);
        }
        catch { /* try next absolute PATH entry */ }
    }
    return undefined;
}
/** Fixed-command, no-shell native picker process port. */
export class NodePickerProcessRunner {
    available(executable) { return resolveExecutable(executable) !== undefined; }
    run(executable, args, cwd, timeoutMs, maxOutputBytes) {
        const resolved = resolveExecutable(executable);
        if (!resolved)
            return Promise.resolve({ unavailable: true });
        return new Promise((resolve) => {
            let child;
            try {
                child = spawn(resolved, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
            }
            catch {
                resolve({ unavailable: true });
                return;
            }
            const chunks = [];
            let bytes = 0;
            let overflow = false;
            let settled = false;
            let terminalResult;
            let forceTimer;
            let forcedCloseTimer;
            const finish = (result) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timeoutTimer);
                if (forceTimer)
                    clearTimeout(forceTimer);
                if (forcedCloseTimer)
                    clearTimeout(forcedCloseTimer);
                resolve(result);
            };
            const terminate = (result) => {
                if (terminalResult || settled)
                    return;
                terminalResult = result;
                child.kill("SIGTERM");
                forceTimer = setTimeout(() => {
                    if (child.exitCode === null && child.signalCode === null)
                        child.kill(process.platform === "win32" ? undefined : "SIGKILL");
                    if (!settled) {
                        forcedCloseTimer = setTimeout(() => finish(result), FORCED_CLOSE_WAIT_MS);
                        forcedCloseTimer.unref();
                    }
                }, TERMINATION_GRACE_MS);
                forceTimer.unref();
            };
            const timeoutTimer = setTimeout(() => terminate({ timedOut: true }), timeoutMs);
            child.stdout?.on("data", (chunk) => {
                if (settled || overflow)
                    return;
                bytes += chunk.length;
                if (bytes > maxOutputBytes) {
                    overflow = true;
                    terminate({ overflow: true });
                    return;
                }
                chunks.push(chunk);
            });
            let stderrBytes = 0;
            child.stderr?.on("data", (chunk) => {
                stderrBytes += chunk.length;
                if (stderrBytes > maxOutputBytes) {
                    overflow = true;
                    terminate({ overflow: true });
                }
            });
            child.on("error", () => finish(terminalResult ?? { unavailable: true }));
            child.on("close", (code) => finish(terminalResult ?? (overflow ? { overflow: true } : { exitCode: code ?? 1, stdout: Buffer.concat(chunks).toString("utf8") })));
        });
    }
}
/** Detects and resolves repository choices; RepositoryBootstrap remains the mutation boundary. */
export class RepositoryChoiceService {
    platform;
    launchCwd;
    runner;
    readLinuxRelease;
    diagnosticSink;
    constructor(deps = {}) {
        this.platform = platformClass(deps.platform ?? process.platform);
        this.launchCwd = deps.launchCwd ?? process.cwd();
        this.runner = deps.runner ?? new NodePickerProcessRunner();
        this.readLinuxRelease = deps.readLinuxRelease ?? defaultLinuxRelease;
        this.diagnosticSink = deps.diagnosticSink ?? ((diagnostic) => { try {
            process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
        }
        catch { /* diagnostics never block onboarding */ } });
    }
    async options() {
        const current = await currentCandidate(this.launchCwd);
        const picker = this.command();
        const linuxDistro = this.platform === "linux" ? distroLabel(await this.readLinuxRelease()) : undefined;
        this.emit({ event: "repository_discovery", platform: this.platform, source: current.source });
        return { platform: this.platform, ...(linuxDistro ? { linuxDistro } : {}), current, browse: picker ? { available: true, picker: picker.kind } : { available: false } };
    }
    async resolve(choice) {
        const options = await this.options();
        if (choice === "current")
            return { result: "selected", candidate: options.current.path, source: options.current.source };
        const started = Date.now();
        const command = this.command();
        if (!command)
            return this.pickerResult({ result: "unavailable" }, "none", started);
        const processResult = await this.runner.run(command.executable, command.args, this.launchCwd, PICKER_TIMEOUT_MS, MAX_PICKER_OUTPUT);
        if (processResult.unavailable)
            return this.pickerResult({ result: "unavailable", picker: command.kind }, command.kind, started);
        if (processResult.timedOut)
            return this.pickerResult({ result: "timeout", picker: command.kind }, command.kind, started);
        if (processResult.overflow)
            return this.pickerResult({ result: "invalid", picker: command.kind }, command.kind, started);
        if (processResult.exitCode !== 0 || !(processResult.stdout ?? "").trim())
            return this.pickerResult({ result: "cancelled", picker: command.kind }, command.kind, started);
        const output = processResult.stdout ?? "";
        if (Buffer.byteLength(output) > MAX_PICKER_OUTPUT || output.includes("\0"))
            return this.pickerResult({ result: "invalid", picker: command.kind }, command.kind, started);
        const lines = output.trim().split(/\r?\n/);
        const absolute = this.platform === "win32" ? win32.isAbsolute(lines[0]) : posix.isAbsolute(lines[0]);
        if (lines.length !== 1 || !absolute)
            return this.pickerResult({ result: "invalid", picker: command.kind }, command.kind, started);
        return this.pickerResult({ result: "selected", candidate: lines[0], source: "picker", picker: command.kind }, command.kind, started);
    }
    pickerResult(result, picker, started) {
        this.emit({ event: "repository_picker", platform: this.platform, picker, result: result.result, durationMs: Math.min(PICKER_TIMEOUT_MS + FORCED_CLOSE_WAIT_MS, Math.max(0, Date.now() - started)) });
        return result;
    }
    emit(diagnostic) { try {
        this.diagnosticSink(diagnostic);
    }
    catch { /* diagnostics never block onboarding */ } }
    command() {
        if (this.platform === "win32")
            return this.runner.available(WINDOWS_COMMAND.executable) ? WINDOWS_COMMAND : undefined;
        if (this.platform === "darwin")
            return this.runner.available(MAC_COMMAND.executable) ? MAC_COMMAND : undefined;
        if (this.platform === "linux")
            return LINUX_COMMANDS.find((command) => this.runner.available(command.executable));
        return undefined;
    }
}
