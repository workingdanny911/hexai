import { Message } from "@hexai/core";

import { MessageSource, MessageSourcePoller } from "@/endpoint";
import { AbstractInboundChannelAdapter } from "./abstract-inbound-channel-adapter";

export class PollingChannelAdapter extends AbstractInboundChannelAdapter {
    constructor(
        protected messageSource: MessageSource,
        protected poller: MessageSourcePoller,
        protected maxMessagesPerPoll = 10
    ) {
        super();
    }

    public setMaxMessagesPerPoll(maxMessagesPerPoll: number): void {
        this.maxMessagesPerPoll = maxMessagesPerPoll;
    }

    public override async onStart(): Promise<void> {
        await this.messageSource.start();

        this.poller.onPoll(() => this.onPoll());
        await this.poller.start();
    }

    private async onPoll(): Promise<void> {
        if (!this.isRunning()) {
            return;
        }

        if (this.maxMessagesPerPoll === 0) {
            await this.pollUntilEmpty();
        } else {
            await this.pollForFixedNumberOfMessages(this.maxMessagesPerPoll);
        }
    }

    private async pollUntilEmpty(): Promise<void> {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const processed = await this.processMessage();
            if (!processed) {
                break;
            }
        }
    }

    private async pollForFixedNumberOfMessages(number: number): Promise<void> {
        for (let i = 0; i < number; i++) {
            const processed = await this.processMessage();
            if (!processed) {
                break;
            }
        }
    }

    protected override async receiveMessage(): Promise<Message | null> {
        return this.messageSource.receive();
    }

    public override async onStop(): Promise<void> {
        await this.poller.stop();
        await this.messageSource.stop();
    }
}
