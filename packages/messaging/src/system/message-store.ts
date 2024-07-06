import { Message } from "@hexai/core";

export interface MessageStore {
    store(key: string, messages: Message[]): Promise<void>;

    get(
        key: string,
        fromPosition: number,
        batchSize?: number
    ): Promise<Message[]>;
}
