import { Message } from "@/message";

export class DomainEvent<
    P extends Record<string, any> = Record<string, unknown>,
> extends Message<P> {
    static override getIntent() {
        return "event";
    }
}
