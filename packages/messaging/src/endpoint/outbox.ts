import { Message } from "@hexai/core";

export interface Outbox {
    store(message: Message): Promise<void>;

    getUnpublishedMessages(
        batchSize?: number
    ): Promise<[number, Array<Message>]>;

    markMessagesAsPublished(
        fromPosition: number,
        number: number
    ): Promise<void>;
}
