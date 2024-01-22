import { EventStoreDBClient } from "@eventstore/db-client";
import { Message } from "@hexai/core";
import { MessageChannel } from "@hexai/messaging";

import { EsdbHelper } from "@/esdb-helper";

export class EsdbOutboundChannel implements MessageChannel {
    constructor(
        private client: EventStoreDBClient,
        private stream: string
    ) {}

    async send(message: Message): Promise<void> {
        await new EsdbHelper(this.client).publishToStream(this.stream, [
            message,
        ]);
    }
}
