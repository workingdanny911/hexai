/* eslint-disable @typescript-eslint/no-unused-vars */
import { Message } from "@hexai/core";

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
        if (!this.isRunning()) {
            return false;
        }

        const message = await this.receiveMessage();
        if (!message) {
            return false;
        }

        await this.sendToOutputChannel(message);

        return true;
    }

    protected async sendToOutputChannel(message: Message): Promise<void> {
        await this.beforeSend(message);

        let error: Error | undefined;
        try {
            await this.outputChannel.send(message);
        } catch (e) {
            error = e as Error;
        }

        await this.afterSend(message, error);
    }

    protected async beforeSend(message: Message): Promise<void> {}

    protected async afterSend(message: Message, error?: Error): Promise<void> {}

    protected abstract receiveMessage(): Promise<Message | null>;
}
