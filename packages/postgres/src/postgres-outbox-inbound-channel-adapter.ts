import { ApplicationContextAware, Message } from "@hexai/core";
import { AbstractInboundChannelAdapter } from "@hexai/messaging";
import { PostgresUnitOfWork } from "@/postgres-unit-of-work";
import { PostgresOutbox } from "@/postgres-outbox";
import { PostgresLock } from "@/postgres-lock";

export class PostgresOutboxInboundChannelAdapter
    extends AbstractInboundChannelAdapter
    implements ApplicationContextAware
{
    private uow!: PostgresUnitOfWork;
    private currentPosition = -1;
    private messages: Message[] = [];
    private lock = new PostgresLock("hexai__outbox_lock");

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
        if (!(await this.acquireLock())) {
            return;
        }

        [this.currentPosition, this.messages] =
            await this.getUnpublishedMessages();

        while (this.messages.length > 0) {
            await this.processMessage();
        }
    }

    private async acquireLock(): Promise<boolean> {
        return await this.uow.wrap(async (client) => {
            this.lock.setClient(client);
            return await this.lock.acquire();
        });
    }

    private async getUnpublishedMessages(): Promise<[number, Message[]]> {
        return await this.uow.wrap(() =>
            this.getOutbox().getUnpublishedMessages()
        );
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

    public async onStop(): Promise<void> {
        if (await this.acquireLock()) {
            await this.lock.release();
        }
    }
}
