import { Message } from "@hexai/core";
import { SqliteUnitOfWork } from "@hexai/core/test";

import { Outbox } from "@/endpoint";

export class SqliteOutbox implements Outbox {
    constructor(private uow: SqliteUnitOfWork) {}

    async store(...messages: Message[]): Promise<void> {
        await this.uow.wrap(async (db) => {
            await this.ensureTableExists();

            for (const message of messages) {
                await db.run(
                    "INSERT INTO outbox (message_id, data) VALUES (?, ?)",
                    [
                        message.getMessageId(),
                        JSON.stringify(message.serialize()),
                    ]
                );
            }
        });
    }

    async getUnpublishedMessages(batchSize = 10): Promise<[number, Message[]]> {
        return this.uow.wrap(async (db) => {
            await this.ensureTableExists();

            const rawMessages = await db.all(
                "SELECT * FROM outbox WHERE published = FALSE ORDER BY position LIMIT ?",
                [batchSize]
            );

            if (rawMessages.length === 0) {
                const result = await db.get(
                    "SELECT MAX(position) AS position FROM outbox"
                );

                if (!result.position) {
                    return [0, []];
                }

                const nextPosition =
                    this.physicalPositionToLogicalPosition(result.position) + 1;
                console.log("result.position", result.position);
                return [nextPosition, []];
            }

            return [
                this.physicalPositionToLogicalPosition(rawMessages[0].position),
                rawMessages.map((raw) => {
                    const data = JSON.parse(raw.data);
                    return Message.from(data.payload, data.headers);
                }),
            ];
        });
    }

    // primary key is 1-based, but position is 0-based
    private physicalPositionToLogicalPosition(
        physicalPosition: number
    ): number {
        return physicalPosition - 1;
    }

    async markMessagesAsPublished(
        fromPosition: number,
        number: number
    ): Promise<void> {
        await this.uow.wrap(async (db) => {
            await this.ensureTableExists();

            await db.run(
                "UPDATE outbox SET published = TRUE WHERE position > ? AND position <= ?",
                [fromPosition, fromPosition + number]
            );
        });
    }

    protected async ensureTableExists(): Promise<void> {
        await this.uow.wrap(async (db) => {
            await db.exec(`
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
        });
    }
}
