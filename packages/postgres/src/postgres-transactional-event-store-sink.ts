import type {
    Message,
    StoredEvent,
    SubscribableEventPublisher,
} from "@hexaijs/core";

import {
    PostgresEventAppender,
    type PostgresEventAppenderConfig,
} from "./postgres-event-appender.js";
import {
    createTransactionResourceKey,
    type PostgresUnitOfWork,
    type TransactionResources,
} from "./postgres-unit-of-work.js";

export interface PostgresTransactionalEventStoreSinkConfig
    extends PostgresEventAppenderConfig {
    onStored?: (storedEvents: StoredEvent[]) => void | Promise<void>;
}

interface BufferedEvents {
    events: Message[];
    drainHookRegistered: boolean;
    draining: boolean;
    closed: boolean;
}

export class TransactionalEventStoreSinkClosedError extends Error {
    constructor(cause?: unknown) {
        super(
            "Cannot accept events after the transactional event store sink has already drained",
            { cause }
        );
        this.name = "TransactionalEventStoreSinkClosedError";
    }
}

export class PostgresTransactionalEventStoreSink {
    private readonly resourceKey =
        createTransactionResourceKey<BufferedEvents>(
            "postgres-transactional-event-store-sink"
        );
    private readonly appender: PostgresEventAppender;
    private readonly onStored:
        PostgresTransactionalEventStoreSinkConfig["onStored"];
    private readonly resources: TransactionResources;

    constructor(
        private readonly unitOfWork: PostgresUnitOfWork & TransactionResources,
        config: PostgresTransactionalEventStoreSinkConfig = {}
    ) {
        assertTransactionResources(unitOfWork);
        this.appender = new PostgresEventAppender(config);
        this.onStored = config.onStored;
        this.resources = unitOfWork;
    }

    async accept(...events: Message[]): Promise<void> {
        if (events.length === 0) {
            return;
        }

        const buffer = this.getOrCreateBuffer();
        this.assertWritable(buffer);

        if (!buffer.drainHookRegistered) {
            this.registerDrainHook(buffer);
            buffer.events.push(...events);
            await this.startTransactionForCommitHooks();
            return;
        }

        buffer.events.push(...events);
    }

    private getOrCreateBuffer(): BufferedEvents {
        return this.resources.getOrCreateTransactionResource(
            this.resourceKey,
            () => ({
                events: [],
                drainHookRegistered: false,
                draining: false,
                closed: false,
            })
        );
    }

    private assertWritable(buffer: BufferedEvents): void {
        if (buffer.closed && !buffer.draining) {
            throw new TransactionalEventStoreSinkClosedError();
        }
    }

    private async startTransactionForCommitHooks(): Promise<void> {
        await this.unitOfWork.withClient(async () => {});
    }

    private registerDrainHook(buffer: BufferedEvents): void {
        try {
            this.unitOfWork.beforeCommit(
                () => this.drain(buffer),
                { phase: "drain" }
            );
        } catch (error) {
            buffer.closed = true;
            throw new TransactionalEventStoreSinkClosedError(error);
        }

        buffer.drainHookRegistered = true;
    }

    private async drain(buffer: BufferedEvents): Promise<void> {
        buffer.draining = true;

        try {
            while (buffer.events.length > 0) {
                const events = buffer.events.splice(0);
                const storedEvents = await this.appender.appendAll(
                    events,
                    this.unitOfWork.getClient()
                );
                await this.onStored?.(storedEvents);
            }
        } finally {
            buffer.draining = false;
            buffer.closed = true;
        }
    }
}

function assertTransactionResources(
    unitOfWork: PostgresUnitOfWork
): asserts unitOfWork is PostgresUnitOfWork & TransactionResources {
    const candidate = unitOfWork as Partial<TransactionResources>;

    if (
        typeof candidate.getOrCreateTransactionResource !== "function" ||
        typeof candidate.getTransactionResource !== "function" ||
        typeof candidate.setTransactionResource !== "function"
    ) {
        throw new Error(
            "PostgresTransactionalEventStoreSink requires a Postgres unit of work that implements TransactionResources"
        );
    }
}

export function attachPostgresEventStoreSink(
    publisher: SubscribableEventPublisher<Message>,
    unitOfWork: PostgresUnitOfWork & TransactionResources,
    config: PostgresTransactionalEventStoreSinkConfig = {}
): () => void {
    const sink = new PostgresTransactionalEventStoreSink(unitOfWork, config);
    return publisher.subscribe((event) => sink.accept(event));
}
