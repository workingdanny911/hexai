import { Message } from "@/message";

export interface PublishedMessageTracker {
    getUnpublishedMessages(
        batchSize?: number
    ): Promise<[number, Array<Message>]>;

    markMessagesAsPublished(
        fromPosition: number,
        number: number
    ): Promise<void>;
}
