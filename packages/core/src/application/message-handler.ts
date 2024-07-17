export interface MessageHandlerObject<M = any, R = any> {
    handle(message: M): R;
}

export type MessageHandlerFunction<M = any, R = any> = (message: M) => R;

export type MessageHandler<M = any, R = any> =
    | MessageHandlerObject<M, R>
    | MessageHandlerFunction<M, R>;

export type AnyMessageHandler = MessageHandler<any, any>;

export type MessageOf<D> = D extends MessageHandler<infer M, any> ? M : never;

export type ResultOf<D> = D extends MessageHandler<any, infer R> ? R : never;

export type FindResultByMessage<Handlers, Msg> = Handlers extends [
    infer H,
    ...infer Rest,
]
    ? MessageOf<H> extends Msg
        ? ResultOf<H>
        : FindResultByMessage<Rest, Msg>
    : never;
