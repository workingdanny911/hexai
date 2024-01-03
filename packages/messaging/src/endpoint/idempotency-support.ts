import { Message } from "@hexai/core/message";

export interface IdempotencySupport {
    isDuplicate(key: string, message: Message, ttl?: number): Promise<boolean>;
    markAsProcessed(key: string, message: Message): Promise<void>;
}
