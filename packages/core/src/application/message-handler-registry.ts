import { MessageHandler } from "./message-handler";

export interface MessageHandlerRegistry<K = any, M = any> {
    register(key: K, handler: MessageHandler<M>): void;
    getByMessage(message: M): MessageHandler<M> | null;
}

export type KeyOf<R extends MessageHandlerRegistry<any, any>> =
    R extends MessageHandlerRegistry<infer K, any> ? K : never;
