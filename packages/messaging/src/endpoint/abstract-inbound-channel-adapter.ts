import { BaseLifecycle } from "@/helpers";
import { InboundChannelAdapter, MessageChannel } from "@/types";
import { Message } from "@hexai/core/message";

export abstract class AbstractInboundChannelAdapter
    extends BaseLifecycle
    implements InboundChannelAdapter
{
    protected outputChannel!: MessageChannel;

    public setOutputChannel(channel: MessageChannel): void {
        this.outputChannel = channel;
    }

    async start(): Promise<void> {
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
