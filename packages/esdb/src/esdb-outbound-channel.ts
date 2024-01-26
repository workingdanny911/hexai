import { EventStoreDBClient } from "@eventstore/db-client";
import { Message, ApplicationContextAware } from "@hexai/core";
import { MessageChannel } from "@hexai/messaging";

import { EsdbHelper } from "@/esdb-helper";

export class EsdbOutboundChannel
    implements MessageChannel, ApplicationContextAware
{
    private client!: EventStoreDBClient;

    constructor(private stream: string) {}

    async send(message: Message): Promise<void> {
        await new EsdbHelper(this.client).publishToStream(this.stream, [
            message,
        ]);
    }

    public setApplicationContext(applicationContext: {
        getEsdbClient(): EventStoreDBClient;
    }): void {
        this.client = applicationContext.getEsdbClient();
    }
}
