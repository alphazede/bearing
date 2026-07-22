import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, mkdir, open, realpath, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { BUILTIN_ROUTES } from "../adapters/adapters.js";
import { EvaluationRunner, type EvaluationCell, type EvaluationReport } from "./evaluation-runner.js";
import { EVALUATION_TRIALS, NATIVE_EVALUATION_MANIFEST, NATIVE_SUITE, SKILLSBENCH_EVALUATION_MANIFEST, SKILLSBENCH_SUITE, SKILLSBENCH_TASK_IDS } from "./suites.js";

const own = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const string = (value: unknown, max = 4096): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const isRepositoryOrDescendant = (root: string, repository: string): boolean => { const path = relative(repository, root); return path === "" || (!path.startsWith("..") && !isAbsolute(path)); };
const validOrigin = (value: unknown): boolean => value === SKILLSBENCH_EVALUATION_MANIFEST.origin || value === `${SKILLSBENCH_EVALUATION_MANIFEST.origin}.git`;

export interface CheckoutInspector { inspect(root: string): { readonly head: string; readonly origin: string; readonly tag: string; readonly clean: boolean }; }
export const readOnlyCheckoutInspector: CheckoutInspector = { inspect: (root) => ({ head: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(), origin: execFileSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(), tag: execFileSync("git", ["-C", root, "rev-parse", `refs/tags/${SKILLSBENCH_EVALUATION_MANIFEST.release}^{commit}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(), clean: execFileSync("git", ["-C", root, "status", "--porcelain", "--ignored", "--untracked-files=all", "--", ...SKILLSBENCH_TASK_IDS.map((id) => `tasks/${id}`)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "" }) };

export class EvaluationCliError extends Error { readonly code: string; constructor(code: string) { super(code); this.code = code; } }
const fail = (code: string): never => { throw new EvaluationCliError(code); };

async function boundedJson(path: string, maximum: number, code: string): Promise<unknown> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) fail(code);
    const content = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < content.length) { const { bytesRead } = await file.read(content, offset, content.length - offset, offset); if (bytesRead === 0) fail(code); offset += bytesRead; }
    if ((await file.read(Buffer.alloc(1), 0, 1, content.length)).bytesRead !== 0) fail(code);
    try { return JSON.parse(content.toString("utf8")); } catch { return fail(code); }
  } catch (error) { if (error instanceof EvaluationCliError) throw error; return fail(code); }
  finally { await file?.close().catch(() => undefined); }
}

function nativeCell(caseId: string, arm: string, route: (typeof BUILTIN_ROUTES)[number], trial: 1 | 2 | 3, workspaceId: string): EvaluationCell {
  return { suiteId: NATIVE_EVALUATION_MANIFEST.suiteId, caseId, arm, route: route.id, trial, workspaceId, identity: { requested: route.id, effective: route.id }, metadata: { source: "synthetic", provider: route.provider, model: route.model === "*" ? "gpt-5.6-terra" : route.model, reasoning: "medium", harness: "native", isolation: "local" }, outcome: "passed", criticalInvariantPassed: true, score: arm === "with-skill" ? 0.75 : 0.5 };
}

export async function runNativeEvaluation(): Promise<{ readonly synthetic: true; readonly providerEvidence: false; readonly eligibleForSkillChange: false; readonly report: EvaluationReport; readonly createdWorkspaces: number; readonly cleanedWorkspaces: number }> {
  const workspaces: string[] = [], results: EvaluationCell[] = [];
  try {
    for (const route of BUILTIN_ROUTES) for (const caseId of NATIVE_EVALUATION_MANIFEST.caseIds) for (const arm of [NATIVE_EVALUATION_MANIFEST.arms.control, NATIVE_EVALUATION_MANIFEST.arms.treatment]) for (const trial of EVALUATION_TRIALS) {
      const workspace = await mkdtemp(join(tmpdir(), "bearing-eval-native-"));
      workspaces.push(workspace); await mkdir(join(workspace, "workspace"));
      results.push(nativeCell(caseId, arm, route, trial, workspace));
    }
    const report = new EvaluationRunner().runSuite(NATIVE_SUITE, results);
    await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
    return { synthetic: true, providerEvidence: false, eligibleForSkillChange: false, report, createdWorkspaces: workspaces.length, cleanedWorkspaces: workspaces.length };
  } catch (error) { await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true }))); throw error; }
}

async function requiredDirectory(path: string): Promise<void> { const stat = await lstat(path).catch(() => undefined); if (!stat?.isDirectory() || stat.isSymbolicLink()) fail("skillsbench_task_structure_invalid"); }
async function requiredFile(path: string): Promise<void> { const stat = await lstat(path).catch(() => undefined); if (!stat?.isFile() || stat.isSymbolicLink()) fail("skillsbench_task_structure_invalid"); }
function parseReceipt(value: unknown, root: string): void {
  if (!own(value, ["root", "origin", "tag", "commit", "status"]) || value.root !== root || !validOrigin(value.origin) || value.tag !== SKILLSBENCH_EVALUATION_MANIFEST.release || value.commit !== SKILLSBENCH_EVALUATION_MANIFEST.commit || value.status !== "PASS") fail("skillsbench_receipt_invalid");
}
function parseResults(value: unknown): EvaluationCell[] {
  const count = SKILLSBENCH_TASK_IDS.length * 2 * BUILTIN_ROUTES.length * EVALUATION_TRIALS.length;
  const cells: unknown[] = Array.isArray(value) ? value : fail("skillsbench_results_invalid");
  if (cells.length !== count) fail("skillsbench_results_invalid");
  for (const cell of cells) {
    const required = ["suiteId", "caseId", "arm", "route", "trial", "workspaceId", "identity", "metadata", "outcome", "criticalInvariantPassed", "score"];
    const record = own(cell, typeof cell === "object" && cell !== null && !Array.isArray(cell) && (cell as Record<string, unknown>).outcome === "failed" ? [...required, "failure"] : required) ? cell : fail("skillsbench_results_invalid");
    const metadata = record.metadata;
    const descriptor = BUILTIN_ROUTES.find(({ id }) => id === record.route);
    if (!string(record.suiteId) || record.suiteId !== SKILLSBENCH_SUITE.suiteId || !string(record.caseId) || !SKILLSBENCH_TASK_IDS.includes(record.caseId as (typeof SKILLSBENCH_TASK_IDS)[number]) || (record.arm !== "curated" && record.arm !== "bearing") || !string(record.route) || !descriptor || !EVALUATION_TRIALS.includes(record.trial as 1 | 2 | 3) || !string(record.workspaceId) || !own(record.identity, ["requested", "effective"]) || record.identity.requested !== descriptor.id || record.identity.effective !== descriptor.id || !own(metadata, ["source", "provider", "model", "reasoning", "harness", "isolation"]) || metadata.source !== "verified-provider" || metadata.isolation !== "attested" || metadata.provider !== descriptor.provider || !string(metadata.model) || (descriptor.model !== "*" && metadata.model !== descriptor.model) || !["low", "medium", "high", "xhigh"].includes(metadata.reasoning as string) || metadata.harness !== "skillsbench-v1.1" || (record.outcome !== "passed" && record.outcome !== "failed") || typeof record.criticalInvariantPassed !== "boolean" || typeof record.score !== "number" || !Number.isFinite(record.score) || record.score < 0 || record.score > 1 || (record.outcome === "failed" && (!own(record.failure, ["code", "message"]) || !string(record.failure.code, 128) || !string(record.failure.message)))) fail("skillsbench_results_invalid");
  }
  return cells as EvaluationCell[];
}

export async function runSkillsbenchEvaluation(input: { readonly root?: string; readonly receipt?: string; readonly results?: string; readonly repositoryRoot?: string; readonly inspector?: CheckoutInspector } = {}): Promise<EvaluationReport> {
  if (!input.root || !input.receipt || !input.results) fail("skillsbench_environment_missing");
  const receiptPath = input.receipt as string, resultsPath = input.results as string, requestedRoot = input.root as string;
  const repository = await realpath(input.repositoryRoot ?? process.cwd());
  const rootStat = await lstat(requestedRoot).catch(() => undefined); if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) fail("skillsbench_root_invalid");
  const root = await realpath(requestedRoot).catch(() => fail("skillsbench_root_invalid"));
  if (isRepositoryOrDescendant(root, repository)) fail("skillsbench_root_in_repository");
  parseReceipt(await boundedJson(receiptPath, 64 * 1024, "skillsbench_receipt_invalid"), root);
  let inspected: ReturnType<CheckoutInspector["inspect"]> | undefined;
  try { inspected = (input.inspector ?? readOnlyCheckoutInspector).inspect(root); } catch { fail("skillsbench_checkout_inspection_failed"); }
  if (!inspected || inspected.head !== SKILLSBENCH_EVALUATION_MANIFEST.commit || inspected.tag !== SKILLSBENCH_EVALUATION_MANIFEST.commit || !validOrigin(inspected.origin) || !inspected.clean) fail("skillsbench_checkout_mismatch");
  const tasks = join(root, "tasks"); await requiredDirectory(tasks);
  for (const id of SKILLSBENCH_TASK_IDS) { const task = join(tasks, id); await requiredDirectory(task); await requiredFile(join(task, "task.md")); for (const part of ["environment", "oracle", "verifier"]) await requiredDirectory(join(task, part)); }
  return new EvaluationRunner().runSuite(SKILLSBENCH_SUITE, parseResults(await boundedJson(resultsPath, 8 * 1024 * 1024, "skillsbench_results_invalid")));
}

async function main(command: string): Promise<void> {
  if (command === "native") { const result = await runNativeEvaluation(); process.stdout.write(`${JSON.stringify(result)}\n`); if (result.report.verdict !== "passed") process.exitCode = 1; return; }
  if (command === "skillsbench") { const report = await runSkillsbenchEvaluation({ root: process.env.BEARING_SKILLSBENCH_ROOT, receipt: process.env.BEARING_SKILLSBENCH_SCAN_RECEIPT, results: process.env.BEARING_SKILLSBENCH_RESULTS }); process.stdout.write(`${JSON.stringify({ providerEvidence: true, externalPanelOnly: true, eligibleForSkillChange: false, report })}\n`); if (report.verdict !== "passed") process.exitCode = 1; return; }
  fail("evaluation_command_invalid");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv[2] ?? "").catch((error: unknown) => { const code = error instanceof EvaluationCliError ? error.code : "evaluation_failed"; process.stderr.write(`${JSON.stringify({ error: code })}\n`); process.exitCode = 1; });
