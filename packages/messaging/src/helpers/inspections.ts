import _ from "lodash";

import { InboundChannelAdapter } from "@/endpoint";
import { MessageChannel, SubscribableMessageChannel } from "@/channel";
import { Lifecycle } from "@/lifecycle";

export function isMessageChannel(obj: unknown): obj is MessageChannel {
    return _.isObject(obj) && "send" in obj;
}

export function isSubscribableChannel(
    obj: unknown
): obj is SubscribableMessageChannel {
    return isMessageChannel(obj) && "subscribe" in obj;
}

function isLifecycle(obj: unknown): obj is Lifecycle {
    return !!(
        _.isObject(obj) &&
        "isRunning" in obj &&
        "start" in obj &&
        "stop"
    );
}

export function isInboundChannelAdapter(
    obj: unknown
): obj is InboundChannelAdapter {
    return isLifecycle(obj) && "setOutputChannel" in obj;
}
