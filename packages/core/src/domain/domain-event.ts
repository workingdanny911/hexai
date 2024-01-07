import { Message } from "@/message";

export abstract class DomainEvent<
    P extends Record<string, any> = Record<string, unknown>,
> extends Message<P> {}
