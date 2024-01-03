import { isObject } from "@/utils";
import { BaseApplicationContext } from "@/application";
import { ApplicationContextAware } from "./application-context-aware";

export function isApplicationContextAware(
    value: unknown
): value is ApplicationContextAware<BaseApplicationContext> {
    return (
        isObject(value) &&
        typeof (value as any).setApplicationContext === "function"
    );
}

export function isUnitOfWorkAware(
    value: unknown
): value is ApplicationContextAware {
    return (
        isObject(value) && typeof (value as any).setUnitOfWork === "function"
    );
}
