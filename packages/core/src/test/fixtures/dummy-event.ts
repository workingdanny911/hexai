import _ from "lodash";

import { Event, MessageHeaders } from "@/message";

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
        headers?: MessageHeaders
    ): DummyEvent {
        return new this(headers);
    }

    constructor(headers?: MessageHeaders) {
        super({}, headers);
    }

    protected serializePayload(): Record<never, never> {
        return this.getPayload();
    }
}
