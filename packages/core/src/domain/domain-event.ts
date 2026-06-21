import { Message } from "../message.js";

import type { MessageOptions } from "../message.js";

export class DomainEvent<
    P extends Record<string, any> = Record<string, unknown>,
> extends Message<P> {
    constructor(payload: P, options?: MessageOptions) {
        super(payload, options);
    }

    static override getIntent() {
        return "event";
    }
}
