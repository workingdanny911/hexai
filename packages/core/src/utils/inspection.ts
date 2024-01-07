import { C } from "ts-toolbelt";

export function isClass(obj: unknown): obj is C.Class {
    return (
        typeof obj === "function" &&
        Object.hasOwn(obj, "prototype") &&
        Object.hasOwn(obj.prototype, "constructor")
    );
}
