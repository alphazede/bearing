import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
/**
 * Resolves an executable name to its canonical path using absolute `PATH`
 * entries only. Shared by repository choice (picker availability) and
 * repository bootstrap (agent-directory refusal); the process runner keeps its
 * own stricter spawn guard, which additionally rejects binaries inside the
 * selected repository.
 */
export function resolveExecutable(executable) {
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
