import { ApplicationContextAware } from "@hexai/core";
import { AbstractInboundChannelAdapter } from "@hexai/messaging";
import { Message } from "@hexai/core";
import { PostgresUnitOfWork } from "@/postgres-unit-of-work";
import { PostgresOutbox } from "@/postgres-outbox";

export class PostgresOutboxInboundChannelAdapter
    extends AbstractInboundChannelAdapter
    implements ApplicationContextAware
{
    private uow!: PostgresUnitOfWork;
    private currentPosition = -1;
    private messages: Message[] = [];

    constructor(private pollingInterval = 100) {
        super();
    }

    protected async onStart(): Promise<void> {
        await super.onStart();

        await this.pollForever();
    }

    private async pollForever(): Promise<void> {
        if (!this.isRunning()) {
            return;
        }

        await this.poll();

        setTimeout(async () => {
            await this.pollForever();
        }, this.pollingInterval);
    }

    private async poll(): Promise<void> {
        const [position, messages] = await this.uow.wrap(() =>
            this.getOutbox().getUnpublishedMessages()
        );

        this.currentPosition = position;
        this.messages = messages;

        while (this.messages.length > 0) {
            await this.processMessage();
        }
    }

    protected async processMessage(): Promise<boolean> {
        return await this.uow.wrap(() => super.processMessage());
    }

    protected async receiveMessage(): Promise<Message | null> {
        return this.messages.shift() ?? null;
    }

    private getOutbox(): PostgresOutbox {
        return new PostgresOutbox(this.uow.getClient());
    }

    protected async afterSend(message: Message, error?: Error): Promise<void> {
        if (error) {
            return;
        }
        await this.getOutbox().markMessagesAsPublished(this.currentPosition, 1);
        this.currentPosition++;
    }

    public setApplicationContext(context: {
        getUnitOfWork(): PostgresUnitOfWork;
    }): void {
        this.uow = context.getUnitOfWork();
    }
}
