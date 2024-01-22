import { Client } from "pg";
import { Message } from "@hexai/core";
import { Outbox } from "@hexai/messaging";

export class PostgresOutbox implements Outbox {
    constructor(private client: Client) {}

    async store(message: Message): Promise<void> {
        await this.client.query(
            "INSERT INTO hexai__outbox (message) VALUES ($1)",
            [message.serialize()]
        );
    }

    async getUnpublishedMessages(batchSize = 10): Promise<[number, Message[]]> {
        const results = await this.client.query(
            "SELECT * FROM hexai__outbox ORDER BY position ASC LIMIT $1",
            [batchSize]
        );

        if (results.rows.length === 0) {
            return [0, []];
        }

        const position = results.rows[0].position;
        const messages = results.rows.map(({ message }) => {
            const { payload, headers } = message;
            return Message.from(payload, headers);
        });

        return [position, messages];
    }

    async markMessagesAsPublished(
        fromPosition: number,
        number: number
    ): Promise<void> {
        await this.client.query(
            "DELETE FROM hexai__outbox WHERE position >= $1 AND position < $2",
            [fromPosition, fromPosition + number]
        );
    }
}
