import { posix, sep, win32 } from "node:path";

const PREFIX = "docs/plans/";
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_SEGMENT = 64;

/** Convert a path returned by the host path.relative() into repository POSIX form. */
export function nativePlanDirectoryPath(value: string, separator: string = sep): string {
  return separator === posix.sep ? value : value.split(separator).join(posix.sep);
}

/** Return the repository-relative plan directory from one contained canonical absolute path. */
export function absolutePlanDirectoryPath(value: string, repositoryRoot: string): string | undefined {
  if (!value || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  const windows = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
  if (windows !== (/^[A-Za-z]:[\\/]/.test(repositoryRoot) || repositoryRoot.startsWith("\\\\"))) return undefined;
  const paths = windows ? win32 : posix;
  if (windows) {
    if (!win32.isAbsolute(value) || !win32.isAbsolute(repositoryRoot) || nativePlanDirectoryPath(win32.normalize(value), win32.sep) !== value.replaceAll("\\", "/")) return undefined;
  } else if (!posix.isAbsolute(value) || !posix.isAbsolute(repositoryRoot) || value.includes("\\") || posix.normalize(value) !== value) return undefined;

  const relative = paths.relative(repositoryRoot, value);
  if (!relative || relative.startsWith("..") || paths.isAbsolute(relative)) return undefined;
  const candidate = nativePlanDirectoryPath(relative, paths.sep);
  return planDirectoryValid(candidate) ? candidate : undefined;
}

export function planDirectoryValid(value: string): boolean {
  if (!value.startsWith(PREFIX) || posix.isAbsolute(value) || posix.normalize(value) !== value) return false;
  const segments = value.slice(PREFIX.length).split("/");
  return segments.length >= 1
    && segments.length <= 3
    && segments.every((segment) => segment.length <= MAX_SEGMENT && SEGMENT.test(segment));
}

export function proposePlanDirectory(goal: string, isoDate: string): string {
  const normalized = goal.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-+|-+$/g, "");
  // ponytail: the slug budget is what is left of the 64-character segment after
  // the date and its separator, not a fixed 72. A fixed cap let this function
  // propose a directory that planDirectoryValid — right below it — rejects.
  const budget = MAX_SEGMENT - isoDate.length - 1;
  const slug = (normalized || "plan").slice(0, Math.max(1, budget)).replaceAll(/-+$/g, "") || "plan";
  return `${PREFIX}${isoDate}-${slug}`;
}
