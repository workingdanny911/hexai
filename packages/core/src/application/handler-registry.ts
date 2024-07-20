import { Handler } from "./handler";

export interface HandlerRegistry<Key = any, Req = any> {
    register(key: Key, handler: Handler<Req>): void;
    getByRequest(request: Req): Handler<Req> | null;
}

export type KeyOf<R extends HandlerRegistry> = R extends HandlerRegistry<
    infer K,
    any
>
    ? K
    : never;
