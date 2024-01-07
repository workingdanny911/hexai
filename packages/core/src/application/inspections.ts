import _ from "lodash";
import { C } from "ts-toolbelt";

import { isClass } from "@/utils";
import { ApplicationContextAware } from "./application-context-aware";
import { UseCase } from "./use-case";
import { EventPublisherAware } from "./event-publisher-aware";

export function isApplicationContextAware(
    value: unknown
): value is ApplicationContextAware<any> {
    return (
        _.isObject(value) &&
        typeof (value as any).setApplicationContext === "function"
    );
}

export function isUseCaseClass(obj: object): obj is C.Class<[object], UseCase> {
    return isClass(obj) && obj.prototype instanceof UseCase;
}

export function isEventPublisherAware(
    value: unknown
): value is EventPublisherAware {
    return (
        _.isObject(value) &&
        typeof (value as any).setEventPublisher === "function"
    );
}
