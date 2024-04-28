import _ from "lodash";
import { isLifecycle } from "@hexai/core";

import { InboundChannelAdapter } from "@/endpoint";
import { MessageChannel, SubscribableMessageChannel } from "@/channel";

export function isMessageChannel(obj: unknown): obj is MessageChannel {
    return _.isObject(obj) && "send" in obj;
}

export function isSubscribableChannel(
    obj: unknown
): obj is SubscribableMessageChannel {
    return isMessageChannel(obj) && "subscribe" in obj;
}

export function isInboundChannelAdapter(
    obj: unknown
): obj is InboundChannelAdapter {
    return isLifecycle(obj) && "setOutputChannel" in obj;
}
