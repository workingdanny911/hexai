import { Event, MessageHeader } from "Hexai/message";

export class DummyEvent extends Event<Record<never, never>> {
    static type = "test.dummy-event";

    constructor(header?: MessageHeader) {
        super({}, header);
    }

    public static from(
        _: Record<never, never>,
        header: MessageHeader
    ): DummyEvent {
        return new this(header);
    }

    protected serializePayload(): Record<never, never> {
        return this.getPayload();
    }
}

export function createDummyEvents(number = 1): Array<DummyEvent> {
    return Array.from({ length: number }).map(() => new DummyEvent());
}
