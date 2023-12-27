import { C } from "ts-toolbelt";

import { EventHandler, UseCase } from "@/application";
import { isClass } from "@/utils";
import { Event } from "@/message";

export * from "./types";

export function isUseCaseClass(obj: object): obj is C.Class<[object], UseCase> {
    return isClass(obj) && obj.prototype instanceof UseCase;
}

export function isEventHandlerClass(
    obj: object
): obj is C.Class<[object], EventHandler> {
    return isClass(obj) && Object.hasOwn(obj.prototype, "handle");
}

export function isMessageClass(cls: object): cls is C.Class {
    return (
        isClass(cls) &&
        "getType" in cls &&
        "getSchemaVersion" in cls &&
        "from" in cls
    );
}

export function isEvent(obj: object): obj is Event {
    try {
        return (
            isMessageClass(obj.constructor) &&
            "serialize" in obj &&
            "getPayload" in obj
        );
    } catch {
        return false;
    }
}
