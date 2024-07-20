import _ from "lodash";

import { ApplicationContextAware } from "./application-context-aware";

export function isApplicationContextAware(
    value: unknown
): value is ApplicationContextAware<any> {
    return (
        _.isObject(value) &&
        typeof (value as any).setApplicationContext === "function"
    );
}
