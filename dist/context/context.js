const MAX_SOURCES = 16;
const MAX_TEXT = 512;
const SECRET = /(?:\b(?:api[_ -]?key|secret|token|password|authorization)\s*[=:]\s*|\bBearer\s+|\bsk-[A-Za-z0-9_-]{8,}|\bAKIA[A-Z0-9]{16})[^\s,;]*/gi;
function boundedText(value) {
    return typeof value === "string" && value.length > 0
        ? value.replace(SECRET, "[redacted]").slice(0, MAX_TEXT)
        : undefined;
}
function boundedSources(value) {
    return value.slice(0, MAX_SOURCES).flatMap((source) => {
        const id = boundedText(source.id);
        const title = boundedText(source.title);
        if (!id || !title)
            return [];
        const excerpt = boundedText(source.excerpt);
        return [{ id, title, ...(excerpt ? { excerpt } : {}) }];
    });
}
/** Retrieves untrusted evidence without accepting or returning policy changes. */
export async function resolveContext(requested, query, port) {
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
    }
    catch {
        return {
            requested,
            effective: "off",
            sources: [],
            warningCodes: ["context_unavailable"],
        };
    }
}
/** Context can annotate a role, but never mutate its authority or limits. */
export function withContext(role, effective) {
    return { ...role, context: effective };
}
