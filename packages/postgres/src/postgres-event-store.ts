import type * as pg from "pg";

import {
    Message,
    EventStore,
    EventStoreFetchResult,
    StoredEvent,
} from "@hexaijs/core";

import {
    PostgresEventAppender,
    type PostgresEventAppenderConfig,
} from "./postgres-event-appender.js";
import type { PostgresUnitOfWork } from "./postgres-unit-of-work.js";

export type PostgresEventStoreConfig = PostgresEventAppenderConfig;

interface EventRow {
    position: string;
    message_type: string;
    headers: Record<string, unknown>;
    payload: Record<string, unknown>;
}

interface FetchRow {
    position: string | null;
    message_type: string | null;
    headers: Record<string, unknown> | null;
    payload: Record<string, unknown> | null;
    last_position: string;
}

export class PostgresEventStore implements EventStore {
    private readonly appender: PostgresEventAppender;

    constructor(
        private readonly uow: PostgresUnitOfWork,
        config: PostgresEventStoreConfig = {}
    ) {
        this.appender = new PostgresEventAppender(config);
    }

    async store(event: Message): Promise<StoredEvent> {
        const [storedEvent] = await this.storeAll([event]);
        return storedEvent;
    }

    async storeAll(events: Message[]): Promise<StoredEvent[]> {
        if (events.length === 0) {
            return [];
        }

        return this.uow.scope(async () => {
            return this.uow.withClient(async (client) => {
                return this.appender.appendAll(events, client);
            });
        });
    }

    async fetch(
        afterPosition: number,
        limit?: number
    ): Promise<EventStoreFetchResult> {
        return this.uow.withClient(async (client) => {
            let eventsQuery = `
                SELECT position, message_type, headers, payload
                FROM ${this.appender.tableName}
                WHERE position > $1
                ORDER BY position ASC
            `;
            const params: unknown[] = [afterPosition];

            if (limit !== undefined) {
                eventsQuery += ` LIMIT $2`;
                params.push(limit);
            }

            const result = await client.query<FetchRow>(
                `WITH event_rows AS (
                     ${eventsQuery}
                 ),
                 last_position AS (
                     SELECT COALESCE(MAX(position), 0) AS value
                     FROM ${this.appender.tableName}
                 )
                 SELECT
                     event_rows.position,
                     event_rows.message_type,
                     event_rows.headers,
                     event_rows.payload,
                     last_position.value AS last_position
                 FROM last_position
                 LEFT JOIN event_rows ON true
                 ORDER BY event_rows.position ASC`,
                params
            );

            const events: StoredEvent[] = result.rows
                .filter(
                    (row): row is EventRow & FetchRow => row.position !== null
                )
                .map((row) => this.deserializeRow(row));

            return {
                events,
                lastPosition: Number(result.rows[0].last_position),
            };
        });
    }

    async *stream(
        afterPosition: number,
        batchSize: number
    ): AsyncGenerator<StoredEvent> {
        let currentPosition = afterPosition;
        let nextBatch = this.fetchBatch(currentPosition, batchSize);

        try {
            while (true) {
                const events = await nextBatch;
                if (events.length === 0) break;

                currentPosition = events[events.length - 1].position;
                nextBatch = this.fetchBatch(currentPosition, batchSize);

                for (const event of events) {
                    yield event;
                }
            }
        } finally {
            nextBatch.catch(() => {});
        }
    }

    private fetchBatch(
        afterPosition: number,
        limit: number
    ): Promise<StoredEvent[]> {
        return this.uow.withClient(async (client) => {
            const result = await client.query<EventRow>(
                `SELECT position, message_type, headers, payload
                 FROM ${this.appender.tableName}
                 WHERE position > $1
                 ORDER BY position ASC
                 LIMIT $2`,
                [afterPosition, limit]
            );
            return result.rows.map((row) => this.deserializeRow(row));
        });
    }

    async getEventCount(afterPosition: number): Promise<number> {
        return this.uow.withClient(async (client) => {
            const result = await client.query<{ count: string }>(
                `SELECT COUNT(*) as count FROM ${this.appender.tableName} WHERE position > $1`,
                [afterPosition]
            );
            return Number(result.rows[0].count);
        });
    }

    async getLastPosition(): Promise<number> {
        return this.uow.withClient(async (client) => {
            return this.queryLastPosition(client);
        });
    }

    private async queryLastPosition(client: pg.ClientBase): Promise<number> {
        const result = await client.query<{ max: string | null }>(
            `SELECT MAX(position) as max FROM ${this.appender.tableName}`
        );

        return Number(result.rows[0].max ?? 0);
    }

    private deserializeRow(row: EventRow): StoredEvent {
        const headers = row.headers;
        const payload = row.payload;

        const event = Message.from(payload, headers as any);

        return {
            position: Number(row.position),
            event,
        };
    }
}
