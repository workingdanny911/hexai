import { Message } from "../message.js";

export class DomainEvent<
    P extends Record<string, any> = Record<string, unknown>,
> extends Message<P> {
    static override getIntent() {
        return "event";
    }
}
