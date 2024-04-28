import _ from "lodash";

import { Lifecycle } from "./lifecycle";

export function isLifecycle(obj: unknown): obj is Lifecycle {
    return !!(
        _.isObject(obj) &&
        "isRunning" in obj &&
        "start" in obj &&
        "stop"
    );
}
