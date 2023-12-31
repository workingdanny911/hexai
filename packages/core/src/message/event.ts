import { Message, MessageHeaders } from "./message";

export abstract class Event<
    T extends Record<string, any> = Record<string, unknown>,
> extends Message<T> {
    public serialize(): {
        headers: MessageHeaders;
        payload: Record<string, unknown>;
    } {
        return {
            headers: { ...this.headers },
            payload: this.serializePayload(this.payload),
        };
    }

    protected abstract serializePayload(payload: T): Record<string, unknown>;
}
