export interface MessageHandler<I, O> {
    handle(message: I): O | Promise<O>;
}

export type MessageHandlerFunction<I, O> = MessageHandler<I, O>["handle"];
