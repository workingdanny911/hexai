import _ from "lodash";

export const anyString = Symbol.for("string");

export const anyDate = Symbol.for("date");

export function partialMatch(
    source: Record<any, any>,
    target: Record<any, any>
): boolean {
    for (const key of Object.keys(target)) {
        const shouldRecurse =
            _.isObject(source[key]) && _.isObject(target[key]);

        if (shouldRecurse) {
            if (!partialMatch(source[key], target[key])) {
                return false;
            }
        } else {
            if (target[key] === anyString && typeof source[key] === "string") {
                continue;
            }

            if (target[key] === anyDate && source[key] instanceof Date) {
                continue;
            }

            if (!_.isEqual(source[key], target[key])) {
                return false;
            }
        }
    }

    return true;
}
