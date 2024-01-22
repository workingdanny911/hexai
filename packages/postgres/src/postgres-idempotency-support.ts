import { IdempotencySupport } from "@hexai/messaging";
import { Message } from "@hexai/core";

import { PostgresUnitOfWork } from "@/postgres-unit-of-work";

export class PostgresIdempotencySupport implements IdempotencySupport {
    constructor(private uow: PostgresUnitOfWork) {}

    async isDuplicate(key: string, message: Message): Promise<boolean> {
        return this.uow.wrap(async (client) => {
            const result = await client.query(
                "SELECT COUNT(*) as count FROM hexai__idempotency_support WHERE key = $1 AND message_id = $2",
                [key, message.getMessageId()]
            );

            return result.rows[0].count > 0;
        });
    }

    async markAsProcessed(
        key: string,
        message: Message<Record<string, unknown>>
    ): Promise<void> {
        return this.uow.wrap(async (client) => {
            await client.query(
                "INSERT INTO hexai__idempotency_support (key, message_id) VALUES ($1, $2)",
                [key, message.getMessageId()]
            );
        });
    }
}
