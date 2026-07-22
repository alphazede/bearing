import type { ContextMode, RoleProjection } from "../profile/profile.js";

export interface ContextSource {
  readonly id: string;
  readonly title: string;
  readonly excerpt?: string;
}

export interface ContextPort {
  retrieve(mode: Exclude<ContextMode, "off">, query: string): Promise<readonly ContextSource[]>;
}

export interface ContextReceipt {
  readonly requested: ContextMode;
  readonly effective: ContextMode;
  readonly sources: readonly ContextSource[];
  readonly warningCodes: readonly string[];
}

const MAX_SOURCES = 16;
const MAX_TEXT = 512;
const SECRET = /(?:\b(?:api[_ -]?key|secret|token|password|authorization)\s*[=:]\s*|\bBearer\s+|\bsk-[A-Za-z0-9_-]{8,}|\bAKIA[A-Z0-9]{16})[^\s,;]*/gi;

function boundedText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.replace(SECRET, "[redacted]").slice(0, MAX_TEXT)
    : undefined;
}

function boundedSources(value: readonly ContextSource[]): readonly ContextSource[] {
  return value.slice(0, MAX_SOURCES).flatMap((source) => {
    const id = boundedText(source.id);
    const title = boundedText(source.title);
    if (!id || !title) return [];
    const excerpt = boundedText(source.excerpt);
    return [{ id, title, ...(excerpt ? { excerpt } : {}) }];
  });
}

/** Retrieves untrusted evidence without accepting or returning policy changes. */
export async function resolveContext(
  requested: ContextMode,
  query: string,
  port?: ContextPort,
): Promise<ContextReceipt> {
  if (requested === "off") {
    return { requested, effective: "off", sources: [], warningCodes: [] };
  }
  if (!port) {
    return {
      requested,
      effective: "off",
      sources: [],
      warningCodes: ["context_unavailable"],
    };
  }
  try {
    return {
      requested,
      effective: requested,
      sources: boundedSources(await port.retrieve(requested, query.slice(0, MAX_TEXT))),
      warningCodes: [],
    };
  } catch {
    return {
      requested,
      effective: "off",
      sources: [],
      warningCodes: ["context_unavailable"],
    };
  }
}

/** Context can annotate a role, but never mutate its authority or limits. */
export function withContext(role: RoleProjection, effective: ContextMode): RoleProjection {
  return { ...role, context: effective };
}
