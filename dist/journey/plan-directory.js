import { posix } from "node:path";
const PREFIX = "docs/plans/";
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_SEGMENT = 64;
export function planDirectoryValid(value) {
    if (!value.startsWith(PREFIX) || posix.isAbsolute(value) || posix.normalize(value) !== value)
        return false;
    const segments = value.slice(PREFIX.length).split("/");
    return segments.length >= 1
        && segments.length <= 3
        && segments.every((segment) => segment.length <= MAX_SEGMENT && SEGMENT.test(segment));
}
export function proposePlanDirectory(goal, isoDate) {
    const normalized = goal.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-+|-+$/g, "");
    // ponytail: the slug budget is what is left of the 64-character segment after
    // the date and its separator, not a fixed 72. A fixed cap let this function
    // propose a directory that planDirectoryValid — right below it — rejects.
    const budget = MAX_SEGMENT - isoDate.length - 1;
    const slug = (normalized || "plan").slice(0, Math.max(1, budget)).replaceAll(/-+$/g, "") || "plan";
    return `${PREFIX}${isoDate}-${slug}`;
}
