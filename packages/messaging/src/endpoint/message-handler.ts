export interface MessageHandlerFunction<I = unknown, O = unknown> {
    (input: I): O | Promise<O>;
}

export interface MessageHandlerObject<I = unknown, O = unknown> {
    handle: MessageHandlerFunction<I, O>;
}

export type MessageHandler<I = unknown, O = unknown> =
    | MessageHandlerObject<I, O>
    | MessageHandlerFunction<I, O>;

export type MessageHandlerFunctionFrom<T extends AnyMessageHandler> =
    T extends MessageHandlerFunction<any, any>
        ? T
        : T extends MessageHandlerObject<infer I, infer O>
          ? MessageHandlerFunction<I, O>
          : never;

export type MessageHandlerObjectFromFunction<F> =
    F extends MessageHandlerObject<infer I, infer O>
        ? MessageHandlerObject<I, O>
        : never;

export type AnyMessageHandler = MessageHandler<any, any>;

export type MessageHandlerFunctionFromObject<
    H extends MessageHandlerObject<any, any>,
> = H extends MessageHandlerObject<infer I, infer O>
    ? MessageHandlerFunction<I, O>
    : never;

export type InputOf<H extends MessageHandler> = H extends MessageHandler<
    infer I,
    any
>
    ? I
    : never;

export type OutputOf<H extends MessageHandler> = H extends MessageHandler<
    any,
    infer O
>
    ? O
    : never;
