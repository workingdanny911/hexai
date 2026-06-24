import * as pg from "pg";

import {
    Message,
    EventStore,
    EventStoreFetchResult,
    StoredEvent,
} from "@hexaijs/core";

import type { PostgresUnitOfWork } from "./postgres-unit-of-work.js";

const DEFAULT_TABLE_NAME = "hexai__events";
const DEFAULT_POSITION_COUNTER_TABLE_NAME = "hexai__event_position_counter";
const COLUMNS_PER_EVENT = 4;

export interface PostgresEventStoreConfig {
    tableName?: string;
    positionCounterTableName?: string;
}

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

interface PostgresError {
    code?: string;
}

export class PostgresEventStore implements EventStore {
    private readonly tableName: string;
    private readonly positionCounterTableName: string;

    constructor(
        private readonly uow: PostgresUnitOfWork,
        config: PostgresEventStoreConfig = {}
    ) {
        this.tableName = config.tableName ?? DEFAULT_TABLE_NAME;
        this.positionCounterTableName = this.resolvePositionCounterTableName(
            config.positionCounterTableName
        );
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
                const firstPosition = await this.allocatePositions(
                    client,
                    events.length
                );
                const values: unknown[] = [];
                const placeholders: string[] = [];

                events.forEach((event, index) => {
                    const position = firstPosition + index;
                    const serialized = event.serialize();
                    const offset = index * COLUMNS_PER_EVENT;
                    placeholders.push(
                        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`
                    );
                    values.push(
                        position,
                        event.getMessageType(),
                        JSON.stringify(serialized.headers),
                        JSON.stringify(serialized.payload)
                    );
                });

                await client.query(
                    `INSERT INTO ${this.tableName} (position, message_type, headers, payload)
                     VALUES ${placeholders.join(", ")}`,
                    values
                );

                return events.map((event, index) => ({
                    position: firstPosition + index,
                    event,
                }));
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
                FROM ${this.tableName}
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
                     FROM ${this.tableName}
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
        const result = await client.query<{ max: string | null }>(
            `SELECT MAX(position) as max FROM ${this.tableName}`
        );

        return Number(result.rows[0].max ?? 0);
    }

    private resolvePositionCounterTableName(
        configuredTableName: string | undefined
    ): string {
        if (configuredTableName) {
            return configuredTableName;
        }
        if (this.tableName === DEFAULT_TABLE_NAME) {
            return DEFAULT_POSITION_COUNTER_TABLE_NAME;
        }
        return `${this.tableName}_position_counter`;
    }

    private async allocatePositions(
        client: pg.ClientBase,
        count: number
    ): Promise<number> {
        // PostgreSQL holds this row lock until the surrounding transaction ends.
        // That is the safety property: a lower position must commit or roll back
        // before any higher position can be assigned and become visible.
        let result: pg.QueryResult<{ last_position: string }>;
        try {
            result = await client.query<{ last_position: string }>(
                `UPDATE ${this.positionCounterTableName}
                 SET last_position = last_position + $1
                 WHERE id = 1
                 RETURNING last_position`,
                [count]
            );
        } catch (error) {
            if (isPostgresError(error, "42P01")) {
                throw new Error(
                    `Event position counter table "${this.positionCounterTableName}" does not exist`,
                    { cause: error }
                );
            }
            throw error;
        }

        if (result.rows.length === 0) {
            throw new Error(
                `Event position counter "${this.positionCounterTableName}" is not initialized`
            );
        }

        const lastPosition = Number(result.rows[0].last_position);
        return lastPosition - count + 1;
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

function isPostgresError(error: unknown, code: string): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as PostgresError).code === code
    );
}
