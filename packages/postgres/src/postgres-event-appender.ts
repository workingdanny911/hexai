import * as pg from "pg";

import { Message, StoredEvent } from "@hexaijs/core";

const DEFAULT_TABLE_NAME = "hexai__events";
const DEFAULT_POSITION_COUNTER_TABLE_NAME = "hexai__event_position_counter";
const COLUMNS_PER_EVENT = 4;

export interface PostgresEventAppenderConfig {
    tableName?: string;
    positionCounterTableName?: string;
}

interface PostgresError {
    code?: string;
}

export class PostgresEventAppender {
    readonly tableName: string;
    private readonly positionCounterTableName: string;

    constructor(config: PostgresEventAppenderConfig = {}) {
        this.tableName = config.tableName ?? DEFAULT_TABLE_NAME;
        this.positionCounterTableName = this.resolvePositionCounterTableName(
            config.positionCounterTableName
        );
    }

    async appendAll(
        events: Message[],
        client: pg.ClientBase
    ): Promise<StoredEvent[]> {
        if (events.length === 0) {
            return [];
        }

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
}

function isPostgresError(error: unknown, code: string): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as PostgresError).code === code
    );
}
