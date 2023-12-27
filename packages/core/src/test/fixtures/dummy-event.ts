import _ from "lodash";

import { Event, MessageHeader } from "@/message";

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
