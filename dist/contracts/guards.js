/**
 * Shared private validation guards.
 *
 * Each guard here is behaviorally identical to the local definitions it
 * replaced (same predicates, same bounds, same key-set strictness). Guards
 * that differ in any way stay local to their module — see park-ranger's
 * boundedText (16_384 bound), focus-mode's string-typed boundedText, and the
 * per-module deepFreeze variants.
 */
const MAX_TEXT = 4096;
export function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function hasExactKeys(value, required) {
    return isObject(value)
        && Object.keys(value).length === required.length
        && required.every((key) => Object.hasOwn(value, key));
}
export function nonNegativeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function positiveInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
export function enumValue(value, values) {
    return typeof value === "string" && values.includes(value);
}
export function boundedText(value, max = MAX_TEXT) {
    return typeof value === "string" && value.length > 0 && value.length <= max && value === value.trim()
        && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
}
export function deepFreeze(value) {
    if (typeof value !== "object" || value === null)
        return value;
    for (const nested of Object.values(value))
        deepFreeze(nested);
    return Object.freeze(value);
}
