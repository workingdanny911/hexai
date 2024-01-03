import {
    InboundChannelAdapter,
    Lifecycle,
    MessageChannel,
    SubscribableMessageChannel,
} from "@/types";

function isObject(obj: unknown): obj is Record<string, unknown> {
    return typeof obj === "object" && obj !== null;
}

export function isMessageChannel(obj: unknown): obj is MessageChannel {
    return isObject(obj) && "send" in obj;
}

export function isSubscribableChannel(
    obj: unknown
): obj is SubscribableMessageChannel {
    return isMessageChannel(obj) && "subscribe" in obj;
}

function isLifecycle(obj: unknown): obj is Lifecycle {
    return !!(isObject(obj) && "isRunning" in obj && "start" in obj && "stop");
}

export function isInboundChannelAdapter(
    obj: unknown
): obj is InboundChannelAdapter {
    return isLifecycle(obj) && "setOutputChannel" in obj;
}
