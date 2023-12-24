import { Event, MessageHeader } from "Hexai/message";
import _ from "lodash";

export class DummyEvent extends Event<Record<never, never>> {
    static type = "test.dummy-event";

    public static create(): DummyEvent {
        return new this();
    }

    public static createMany(number: number): DummyEvent[] {
        return _.times(number, () => this.create());
    }

    public static from(
        _: Record<never, never>,
        header?: MessageHeader
    ): DummyEvent {
        return new this(header);
    }

    constructor(header?: MessageHeader) {
        super({}, header);
    }

    protected serializePayload(): Record<never, never> {
        return this.getPayload();
    }
}

export function createDummyEvents(number = 1): Array<DummyEvent> {
    return Array.from({ length: number }).map(() => new DummyEvent());
}
