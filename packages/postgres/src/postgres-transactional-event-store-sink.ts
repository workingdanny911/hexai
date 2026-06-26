import type {
    Message,
    SubscribableEventPublisher,
} from "@hexaijs/core";

import {
    PostgresEventAppender,
    type PostgresEventAppenderConfig,
} from "./postgres-event-appender.js";
import {
    createTransactionResourceKey,
    type PostgresUnitOfWork,
    type TransactionResourceAware,
} from "./postgres-unit-of-work.js";

export type PostgresTransactionalEventStoreSinkConfig =
    PostgresEventAppenderConfig;

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
    private readonly resources: TransactionResourceAware;

    constructor(
        private readonly unitOfWork:
            PostgresUnitOfWork & TransactionResourceAware,
        config: PostgresTransactionalEventStoreSinkConfig = {}
    ) {
        assertTransactionResourceAware(unitOfWork);
        this.appender = new PostgresEventAppender(config);
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
            await this.startTransactionForCommitHooks();
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
                await this.appender.appendAll(
                    events,
                    this.unitOfWork.getClient()
                );
            }
        } finally {
            buffer.draining = false;
            buffer.closed = true;
        }
    }
}

function assertTransactionResourceAware(
    unitOfWork: PostgresUnitOfWork
): asserts unitOfWork is PostgresUnitOfWork & TransactionResourceAware {
    const candidate = unitOfWork as Partial<TransactionResourceAware>;

    if (
        typeof candidate.getOrCreateTransactionResource !== "function" ||
        typeof candidate.getTransactionResource !== "function" ||
        typeof candidate.setTransactionResource !== "function"
    ) {
        throw new Error(
            "PostgresTransactionalEventStoreSink requires a Postgres unit of work that implements TransactionResourceAware"
        );
    }
}

export function attachPostgresEventStoreSink(
    publisher: SubscribableEventPublisher<Message>,
    unitOfWork: PostgresUnitOfWork & TransactionResourceAware,
    config: PostgresTransactionalEventStoreSinkConfig = {}
): () => void {
    const sink = new PostgresTransactionalEventStoreSink(unitOfWork, config);
    return publisher.subscribe((event) => sink.accept(event));
}
