import { expect } from "vitest";
import { EventStoreDBClient } from "@eventstore/db-client";
import { Message, MessageRegistry } from "@hexai/core";
import { DummyMessage, setExpect } from "@hexai/core/test";

import { EsdbHelper } from "./esdb-helper";

setExpect(expect);

export class DummyMessageV2 extends DummyMessage {
    static schemaVersion = "2.0.0";
}

export class EventWithData extends Message<{
    stringValue: string;
    numberValue: number;
    booleanValue: boolean;
    arrayValue: Array<number>;
    nullValue: null;
    objectValue: {
        key: string;
    };
}> {
    static type = "test.event-with-data";

    protected serializePayload(payload: any): Record<string, unknown> {
        return payload;
    }
}

export const messageRegistry = new MessageRegistry();
messageRegistry.register(DummyMessage);
messageRegistry.register(DummyMessageV2);
messageRegistry.register(EventWithData);

export const esdbClient = new EventStoreDBClient(
    {
        endpoint: "localhost:2113",
    },
    {
        insecure: true,
    }
);

EsdbHelper.bindMessageRegistry(messageRegistry);
