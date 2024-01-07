import _ from "lodash";

import { Message, MessageHeaders } from "@/message";

export class DummyMessage extends Message<Record<never, never>> {
    static type = "test.dummy-message";

    public static create() {
        return new this({});
    }

    public static createMany(number: number) {
        return _.times(number, () => this.create());
    }

    public static from(
        _: Record<never, never>,
        headers?: MessageHeaders
    ): DummyMessage {
        return new this({}, headers);
    }
}
