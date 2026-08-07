import { createHash, createHmac } from "node:crypto";
import { resolve } from "node:path";

/**
 * Workspace-keyed digest factory (issue #14). Outcome references are keyed
 * with the workspace identity so identical values do not collide across
 * repositories, and an HMAC reference cannot be recomputed from a guessed
 * plaintext alone. The key is the sha256 of the resolved repository root —
 * the same path normalization BearingStore applies to its own root — so it is
 * stable per workspace, is not itself secret-derived, and never appears in any
 * output: every produced reference is a 64-hex HMAC-SHA256 that reveals
 * neither the key nor the underlying path. The key stays inside the returned
 * closure and is never persisted or exported.
 */
export function workspaceKeyedDigest(repositoryPath: string): (value: string) => string {
  const key = createHash("sha256").update(resolve(repositoryPath)).digest();
  return (value: string) => createHmac("sha256", key).update(value).digest("hex");
}
