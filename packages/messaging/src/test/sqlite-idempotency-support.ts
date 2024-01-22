import * as sqlite from "sqlite";
import { Message } from "@hexai/core";

import { IdempotencySupport } from "@/endpoint";

export class SqliteIdempotencySupport implements IdempotencySupport {
    constructor(protected db: sqlite.Database) {}

    async isDuplicate(key: string, message: Message): Promise<boolean> {
        await this.ensureTableExists();

        const result = await this.db.get(
            "SELECT COUNT(*) as count FROM idempotency WHERE key = ? AND message_id = ?",
            [key, message.getMessageId()]
        );

        return result.count > 0;
    }

    async markAsProcessed(key: string, message: Message): Promise<void> {
        await this.ensureTableExists();
        await this.db.run(
            "INSERT INTO idempotency (key, message_id) VALUES (?, ?)",
            [key, message.getMessageId()]
        );
    }

    protected async ensureTableExists(): Promise<void> {
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS idempotency (
                key TEXT NOT NULL,
                message_id TEXT NOT NULL,
                PRIMARY KEY (key, message_id)
            );
        `);
    }
}
