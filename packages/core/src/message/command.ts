import { Message } from "./message";

export abstract class Command<
    T extends Record<string, any> = Record<string, unknown>,
> extends Message<T> {}
