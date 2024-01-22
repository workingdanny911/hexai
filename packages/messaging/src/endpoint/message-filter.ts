interface MessageFilterFunction<I = unknown> {
    (message: I): boolean | Promise<boolean>;
}

export interface MessageFilterObject<M = unknown> {
    select: MessageFilterFunction<M>;
}

export type MessageFilter<M = unknown> =
    | MessageFilterObject<M>
    | MessageFilterFunction<M>;
