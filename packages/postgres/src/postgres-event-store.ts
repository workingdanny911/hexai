import * as pg from "pg";

import {
    Message,
    EventStore,
    EventStoreFetchResult,
    StoredEvent,
} from "@hexaijs/core";

import type { PostgresUnitOfWork } from "./postgres-unit-of-work.js";

const DEFAULT_TABLE_NAME = "hexai__events";
const COLUMNS_PER_EVENT = 3;

export interface PostgresEventStoreConfig {
    tableName?: string;
}

interface EventRow {
    position: number;
    message_type: string;
    headers: Record<string, unknown>;
    payload: Record<string, unknown>;
}

export class PostgresEventStore implements EventStore {
    private readonly tableName: string;

    constructor(
        private readonly uow: PostgresUnitOfWork,
        config: PostgresEventStoreConfig = {}
    ) {
        this.tableName = config.tableName ?? DEFAULT_TABLE_NAME;
    }

    async store(event: Message): Promise<StoredEvent> {
        return this.uow.withClient(async (client) => {
            const serialized = event.serialize();

            const result = await client.query<{ position: number }>(
                `INSERT INTO ${this.tableName} (message_type, headers, payload)
                 VALUES ($1, $2, $3)
                 RETURNING position`,
                [
                    event.getMessageType(),
                    JSON.stringify(serialized.headers),
                    JSON.stringify(serialized.payload),
                ]
            );

            return {
                position: +result.rows[0].position,
                event,
            };
        });
    }

    async storeAll(events: Message[]): Promise<StoredEvent[]> {
        if (events.length === 0) {
            return [];
        }

        return this.uow.withClient(async (client) => {
            const values: unknown[] = [];
            const placeholders: string[] = [];

            events.forEach((event, index) => {
                const serialized = event.serialize();
                const offset = index * COLUMNS_PER_EVENT;
                placeholders.push(
                    `($${offset + 1}, $${offset + 2}, $${offset + 3})`
                );
                values.push(
                    event.getMessageType(),
                    JSON.stringify(serialized.headers),
                    JSON.stringify(serialized.payload)
                );
            });

            const result = await client.query<{ position: number }>(
                `INSERT INTO ${this.tableName} (message_type, headers, payload)
                 VALUES ${placeholders.join(", ")}
                 RETURNING position`,
                values
            );

            return result.rows.map((row, index) => ({
                position: +row.position,
                event: events[index],
            }));
        });
    }

    async fetch(
        afterPosition: number,
        limit?: number
    ): Promise<EventStoreFetchResult> {
        return this.uow.withClient(async (client) => {
            const lastPosition = await this.queryLastPosition(client);

            let query = `
                SELECT position, message_type, headers, payload
                FROM ${this.tableName}
                WHERE position > $1
                ORDER BY position ASC
            `;
            const params: unknown[] = [afterPosition];

            if (limit !== undefined) {
                query += ` LIMIT $2`;
                params.push(limit);
            }

            const result = await client.query<EventRow>(query, params);

            const events: StoredEvent[] = result.rows.map((row) =>
                this.deserializeRow(row)
            );

            return {
                events,
                lastPosition,
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
                 FROM ${this.tableName}
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
                `SELECT COUNT(*) as count FROM ${this.tableName} WHERE position > $1`,
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
        const result = await client.query<{ max: number | null }>(
            `SELECT MAX(position) as max FROM ${this.tableName}`
        );

        return +(result.rows[0].max ?? 0);
    }

    private deserializeRow(row: EventRow): StoredEvent {
        const headers = row.headers;
        const payload = row.payload;

        const event = Message.from(payload, headers as any);

        return {
            position: +row.position,
            event,
        };
    }
}
