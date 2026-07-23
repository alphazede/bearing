import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

const MAX_DEPTH = 4;
const MAX_PATHS = 200;
const OMITTED = new Set([".git", ".bearing", "node_modules", "vendor", "dist", "build", "out", "coverage", ".next", ".cache"]);
const SENSITIVE = /(^|[._-])(env|secret|credential|token|password|private)([._-]|$)/i;

function inside(root: string, path: string): boolean {
  const relation = relative(root, path);
  return relation !== "" && !relation.startsWith("..") && !isAbsolute(relation);
}

async function containedDirectory(root: string, directory: string): Promise<string | undefined> {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
    const canonical = await realpath(directory);
    return inside(root, canonical) ? canonical : undefined;
  } catch { return undefined; }
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-+|-+$/g, "");
  return (normalized || "plan").slice(0, 72).replaceAll(/-+$/g, "") || "plan";
}

async function inventory(root: string): Promise<readonly string[]> {
  const paths: string[] = [];
  const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || paths.length >= MAX_PATHS) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (paths.length >= MAX_PATHS || OMITTED.has(entry.name) || SENSITIVE.test(entry.name) || entry.isSymbolicLink()) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      paths.push(entry.isDirectory() ? `${path}/` : path);
      if (entry.isDirectory()) await visit(resolve(directory, entry.name), path, depth + 1);
    }
  };
  await visit(root, "", 0);
  return paths;
}

function mapText(repository: string, paths: readonly string[]): string {
  return [
    "---",
    "type: repository-map",
    `repository: ${basename(repository)}`,
    "scope: bounded-path-inventory",
    "---",
    "",
    "# Repository map",
    "",
    "This is a bounded path inventory generated for this journey. It contains no file contents; verify live state only when this map is insufficient.",
    "",
    "## Paths",
    ...paths.map((path) => `- \`${path}\``),
    ...(paths.length === MAX_PATHS ? ["- _(inventory capped at 200 paths)_"] : []),
    "",
  ].join("\n");
}

export interface BearingsWorkspace {
  readonly directory: string;
  readonly artifacts: readonly string[];
  readonly resumed: boolean;
}

/** Creates one canonical, collision-safe plan stub and its reusable bounded map. */
export async function setBearingsWorkspace(repository: string, goal: string, existingDirectory?: string): Promise<BearingsWorkspace | undefined> {
  const plans = resolve(repository, "docs/plans");
  await mkdir(plans, { recursive: true });
  if (!inside(repository, await realpath(plans))) return undefined;

  let directory: string;
  let resumed = false;
  if (existingDirectory) {
    if (!/^docs\/plans\/\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(existingDirectory)) return undefined;
    directory = resolve(repository, existingDirectory);
    if (!await containedDirectory(repository, directory)) return undefined;
    resumed = true;
  } else {
    const date = new Date().toISOString().slice(0, 10);
    const stem = `${date}-${slug(goal)}`;
    let suffix = 1;
    while (true) {
      const candidate = resolve(plans, suffix === 1 ? stem : `${stem}-${suffix}`);
      try { await mkdir(candidate); directory = candidate; break; }
      catch (error: unknown) { if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error; suffix += 1; }
    }
  }
  const relativeDirectory = relative(repository, directory).replaceAll("\\", "/");
  const planSpec = resolve(directory, "plan-spec.md");
  const prompts = resolve(directory, "prompts");
  try { await mkdir(prompts); }
  catch (error: unknown) { if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error; }
  const canonicalDirectory = await containedDirectory(repository, directory);
  if (!canonicalDirectory || !await containedDirectory(canonicalDirectory, prompts)) return undefined;
  const map = resolve(prompts, "repository-map.md");
  try {
    await writeFile(planSpec, `---\ntype: plan-spec\nname: ${slug(goal)}\nstatus: pre-grill-draft\ndate: ${new Date().toISOString().slice(0, 10)}\napplies_to: ${slug(basename(repository))}\n---\n`, { flag: "wx" });
  } catch (error: unknown) { if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error; }
  try { await writeFile(map, mapText(repository, await inventory(repository)), { flag: "wx" }); }
  catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  return { directory: relativeDirectory, artifacts: [`${relativeDirectory}/prompts/repository-map.md`, `${relativeDirectory}/plan-spec.md`], resumed };
}
