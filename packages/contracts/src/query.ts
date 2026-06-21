import { Message } from "@hexaijs/core";

import type { MessageOptions } from "@hexaijs/core";

export class Query<Payload = unknown, ResultType = unknown> extends Message<Payload> {
    declare readonly ResultType: ResultType;

    constructor(payload: Payload, options?: MessageOptions) {
        super(payload, options);
    }

    static override getIntent(): string {
        return "query";
    }
}
