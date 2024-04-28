import * as sqlite from "sqlite";
import { Message } from "@hexai/core";

import { Outbox } from "@/endpoint";

export class SqliteOutbox implements Outbox {
    constructor(private db: sqlite.Database) {}

    async store(message: Message<Record<string, unknown>>): Promise<void> {
        await this.ensureTableExists();

        await this.db.run(
            "INSERT INTO outbox (message_id, data) VALUES (?, ?)",
            [message.getMessageId(), JSON.stringify(message.serialize())]
        );
    }

    async getUnpublishedMessages(batchSize = 10): Promise<[number, Message[]]> {
        await this.ensureTableExists();

        const result = await this.db.get(
            "SELECT position FROM outbox WHERE published = FALSE ORDER BY position LIMIT 1"
        );

        if (!result) {
            return [0, []];
        }

        const position = result.position - 1;
        const rawMessages = await this.db.all(
            "SELECT data FROM outbox WHERE position > ? ORDER BY position LIMIT ?",
            [position, batchSize]
        );

        return [
            position,
            rawMessages.map((raw) => {
                const data = JSON.parse(raw.data);
                return Message.from(data.payload, data.headers);
            }),
        ];
    }

    async markMessagesAsPublished(
        fromPosition: number,
        number: number
    ): Promise<void> {
        await this.ensureTableExists();

        await this.db.run(
            "UPDATE outbox SET published = TRUE WHERE position > ? AND position <= ?",
            [fromPosition, number]
        );
    }

    protected async ensureTableExists(): Promise<void> {
        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS outbox
            (
                position
                INTEGER
                PRIMARY
                KEY
                AUTOINCREMENT,
                message_id
                TEXT
                NOT
                NULL,
                published
                BOOLEAN
                NOT
                NULL
                DEFAULT
                FALSE,
                data
                TEXT
                NOT
                NULL
            );
        `);
    }
}
