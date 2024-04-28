import { beforeEach, describe, expect, test } from "vitest";
import { Message } from "@hexai/core";
import { DummyMessage } from "@hexai/core/test";

import { esdbClient, EventWithData } from "@/test-fixtures";
import { EsdbHelper, RawEventInStream } from "@/esdb-helper";

const wrapper = new EsdbHelper(esdbClient);

async function deleteStream() {
    try {
        await esdbClient.deleteStream("test");
    } catch {}
}

beforeEach(async () => {
    await deleteStream();

    return deleteStream;
});

function expectEventsToFullyEqual(
    events: Array<Message>,
    expectedEvents: Array<Message>
) {
    expect(events).toEqual(expectedEvents);
}

describe("reading events", () => {
    const toESDBEvent = (event: Message) => EsdbHelper.serialize(event);

    // since there's no way to get the position of the first event in a stream,
    // we create a dummy event first, read it, and then delete the stream
    async function createStreamForTest(streamName: string): Promise<number> {
        let initialPosition: number;

        const initialEventToCreateStream = DummyMessage.create();
        await esdbClient.appendToStream(streamName, [
            toESDBEvent(initialEventToCreateStream),
        ]);

        for await (const { event } of esdbClient.readStream(streamName, {})) {
            initialPosition = Number(event!.revision);
        }

        await deleteStream();

        return initialPosition! + 1;
    }

    test("reading non-existing stream", async () => {
        const events = await wrapper.readStream("non-exsiting-stream");
        expectEventsToFullyEqual(events, []);
    });

    test("reading events", async () => {
        const events = DummyMessage.createMany(10);

        await esdbClient.appendToStream("test", events.map(toESDBEvent));

        const eventsFetched = await wrapper.readStream("test");
        expectEventsToFullyEqual(eventsFetched, events);
    });

    test("reading events with data", async () => {
        const event = new EventWithData({
            stringValue: "string",
            numberValue: 1,
            booleanValue: true,
            arrayValue: [1, 2, 3],
            nullValue: null,
            objectValue: {
                key: "value",
            },
        });

        await esdbClient.appendToStream("test", [toESDBEvent(event)]);

        const [eventFetched] = await wrapper.readStream("test");
        expectEventsToFullyEqual([eventFetched], [event]);
    });

    test("reading from position", async () => {
        const initialPosition = await createStreamForTest("test");
        const events = DummyMessage.createMany(10);
        await esdbClient.appendToStream("test", events.map(toESDBEvent));

        const eventsFetched = await wrapper.readStream("test", {
            fromPosition: initialPosition + 5,
        });

        expectEventsToFullyEqual(eventsFetched, events.slice(5));
    });

    test("reading fixed number of events", async () => {
        const events = DummyMessage.createMany(10);
        await esdbClient.appendToStream("test", events.map(toESDBEvent));

        const eventsFetched = await wrapper.readStream("test", {
            numberOfEvents: 5,
        });

        expectEventsToFullyEqual(eventsFetched, events.slice(0, 5));
    });

    test("reading fixed number of events from position", async () => {
        const initialPosition = await createStreamForTest("test");
        const events = DummyMessage.createMany(10);
        await esdbClient.appendToStream("test", events.map(toESDBEvent));

        const eventsFetched = await wrapper.readStream("test", {
            fromPosition: initialPosition,
            numberOfEvents: 1,
        });

        expectEventsToFullyEqual(eventsFetched, events.slice(0, 1));
    });
});

describe("publishing events to event store db", () => {
    test("publishing - empty events", async () => {
        const events = DummyMessage.createMany(10);

        await wrapper.publishToStream("test", events);

        const eventsRead = await wrapper.readStream("test");
        expectEventsToFullyEqual(eventsRead, events);
    });

    test("publishing - events with data", async () => {
        const events = [
            new EventWithData({
                stringValue: "string",
                numberValue: 1,
                booleanValue: true,
                arrayValue: [1, 2, 3],
                nullValue: null,
                objectValue: {
                    key: "value",
                },
            }),
            new EventWithData({
                stringValue: "string2",
                numberValue: 2,
                booleanValue: false,
                arrayValue: [4, 5, 6],
                nullValue: null,
                objectValue: {
                    key: "value2",
                },
            }),
        ];

        await wrapper.publishToStream("test", events);

        const eventsRead = await wrapper.readStream("test");
        expectEventsToFullyEqual(eventsRead, events);
    });
});

describe("deleting a stream", () => {
    test("deleting a stream", async () => {
        const events = DummyMessage.createMany(10);

        await wrapper.publishToStream("test", events);
        await wrapper.deleteStream("test");

        const eventsRead = await wrapper.readStream("test");
        expectEventsToFullyEqual(eventsRead, []);
    });

    test("deleting a non-existing stream", async () => {
        // should not throw
        await wrapper.deleteStream("non-existing-stream");
    });
});
