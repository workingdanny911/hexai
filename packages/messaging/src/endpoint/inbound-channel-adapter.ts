import { Lifecycle } from "@hexai/core";

import { MessageChannel } from "@/channel";

export interface InboundChannelAdapter extends Lifecycle {
    setOutputChannel(channel: MessageChannel): void;
}
