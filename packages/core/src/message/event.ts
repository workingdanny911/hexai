import { Message, MessageHeader } from "./message";

export abstract class Event<
    T extends Record<string, any> = Record<string, unknown>,
> extends Message<T> {
    public serialize(): {
        header: MessageHeader;
        payload: Record<string, unknown>;
    } {
        return {
            header: this.header,
            payload: this.serializePayload(this.payload),
        };
    }

    protected abstract serializePayload(payload: T): Record<string, unknown>;
}
