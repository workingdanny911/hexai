export interface MessageHandlerFunction<I = unknown, O = unknown> {
    (input: I): O | Promise<O>;
}

export interface MessageHandlerObject<I = unknown, O = unknown> {
    handle: MessageHandlerFunction<I, O>;
}

export type MessageHandler<I = unknown, O = unknown> =
    | MessageHandlerObject<I, O>
    | MessageHandlerFunction<I, O>;
