export interface MessageFilter<M> {
    select(message: M): boolean | Promise<boolean>;
}

export type MessageFilterFunction<M> = MessageFilter<M>["select"];
