import { Message } from "@hexai/core";

export interface IdempotencySupport {
    isDuplicate(key: string, message: Message, ttl?: number): Promise<boolean>;
    markAsProcessed(key: string, message: Message): Promise<void>;
}
