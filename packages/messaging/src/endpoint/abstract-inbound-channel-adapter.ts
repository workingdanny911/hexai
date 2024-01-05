import { Message } from "@hexai/core/message";

import { AbstractLifecycle } from "@/helpers";
import { MessageChannel } from "@/channel";
import { InboundChannelAdapter } from "./inbound-channel-adapter";

export abstract class AbstractInboundChannelAdapter
    extends AbstractLifecycle
    implements InboundChannelAdapter
{
    protected outputChannel!: MessageChannel;

    public setOutputChannel(channel: MessageChannel): void {
        this.outputChannel = channel;
    }

    public override async start(): Promise<void> {
        if (!this.outputChannel) {
            throw new Error("output channel required");
        }

        await super.start();
    }

    protected async processMessage(): Promise<boolean> {
        const message = await this.receiveMessage();
        if (!message) {
            return false;
        }

        await this.outputChannel.send(message);
        return true;
    }

    protected abstract receiveMessage(): Promise<Message | null>;
}
