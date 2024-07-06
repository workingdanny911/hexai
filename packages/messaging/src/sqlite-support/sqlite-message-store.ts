import { Message } from "@hexai/core";
import { SqliteUnitOfWork } from "@hexai/core/test";

import { MessageStore } from "@/system";

export class SqliteMessageStore implements MessageStore {
    constructor(private uow: SqliteUnitOfWork) {}

    async store(key: string, messages: Message[]): Promise<void> {
        await this.createTableIfNotExists();

        await this.insertMessages(key, messages);
    }

    private insertMessages(key: string, messages: Message[]) {
        return this.uow.wrap(async () => {
            for (const message of messages) {
                await this.insertMessage(key, message);
            }
        });
    }

    private insertMessage(key: string, message: Message) {
        const { payload, headers } = message.serialize();

        return this.uow
            .getClient()
            .run(
                "INSERT INTO message_store__messages (key, payload, headers, messageId) VALUES (?, ?, ?, ?)",
                [
                    key,
                    JSON.stringify(payload),
                    JSON.stringify(headers),
                    message.getMessageId(),
                ]
            );
    }

    private async createTableIfNotExists() {
        await this.uow.wrap((connection) =>
            connection.run(`
            CREATE TABLE IF NOT EXISTS message_store__messages (
                key TEXT NOT NULL,
                position INTEGER PRIMARY KEY AUTOINCREMENT,
                payload TEXT NOT NULL,
                headers TEXT NOT NULL,
                messageId TEXT NOT NULL UNIQUE
            )
        `)
        );
    }

    public async get(
        key: string,
        fromPosition = 0,
        batchSize?: number
    ): Promise<Message[]> {
        await this.createTableIfNotExists();

        const rows = await this.uow.wrap((connection) =>
            connection.all(
                "SELECT * FROM message_store__messages WHERE key = ? AND position >= ? ORDER BY position ASC LIMIT ?",
                key,
                this.physicalPositionToLogicalPosition(fromPosition),
                batchSize ?? -1
            )
        );

        return rows.map((row) =>
            Message.from(JSON.parse(row.payload), JSON.parse(row.headers))
        );
    }

    private physicalPositionToLogicalPosition(physicalPosition: number) {
        return physicalPosition + 1;
    }
}
