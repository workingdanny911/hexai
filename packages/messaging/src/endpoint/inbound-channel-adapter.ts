import { Lifecycle } from "@/lifecycle";
import { MessageChannel } from "@/channel";

export interface InboundChannelAdapter extends Lifecycle {
    setOutputChannel(channel: MessageChannel): void;
}
