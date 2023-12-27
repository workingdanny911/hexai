import { C } from "ts-toolbelt";

export * from "./database";
export * from "./object-registry";
export * from "./types";

export function isClass(obj: object): obj is C.Class {
    return (
        typeof obj === "function" &&
        Object.hasOwn(obj, "prototype") &&
        Object.hasOwn(obj.prototype, "constructor")
    );
}
