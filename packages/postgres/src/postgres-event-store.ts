import { Client, PoolClient } from "pg";
import {
    Message,
    EventStore,
    EventStoreFetchResult,
    StoredEvent,
} from "@hexaijs/core";

type PgClient = Client | PoolClient;

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
        private readonly client: PgClient,
        config: PostgresEventStoreConfig = {}
    ) {
        this.tableName = config.tableName ?? DEFAULT_TABLE_NAME;
    }

    async store(event: Message): Promise<StoredEvent> {
        const serialized = event.serialize();

        const result = await this.client.query<{ position: number }>(
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
    }

    async storeAll(events: Message[]): Promise<StoredEvent[]> {
        if (events.length === 0) {
            return [];
        }

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

        const result = await this.client.query<{ position: number }>(
            `INSERT INTO ${this.tableName} (message_type, headers, payload)
             VALUES ${placeholders.join(", ")}
             RETURNING position`,
            values
        );

        return result.rows.map((row, index) => ({
            position: +row.position,
            event: events[index],
        }));
    }

    async fetch(
        afterPosition: number,
        limit?: number
    ): Promise<EventStoreFetchResult> {
        const lastPosition = await this.getLastPosition();

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

        const result = await this.client.query<EventRow>(query, params);

        const events: StoredEvent[] = result.rows.map((row) =>
            this.deserializeRow(row)
        );

        return {
            events,
            lastPosition,
        };
    }

    async getLastPosition(): Promise<number> {
        const result = await this.client.query<{ max: number | null }>(
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
