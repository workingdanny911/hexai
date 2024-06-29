import { isObject } from "lodash";
import { C } from "ts-toolbelt";
import { Lifecycle } from "./lifecycle";

export function isClass(obj: unknown): obj is C.Class {
    return (
        typeof obj === "function" &&
        Object.hasOwn(obj, "prototype") &&
        Object.hasOwn(obj.prototype, "constructor")
    );
}

export function isLifecycle(obj: unknown): obj is Lifecycle {
    return !!(isObject(obj) && "isRunning" in obj && "start" in obj && "stop");
}
