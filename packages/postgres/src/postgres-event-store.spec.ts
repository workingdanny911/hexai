import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { Message } from "@hexaijs/core";

import { PostgresEventStore } from "./postgres-event-store.js";
import {
    useDatabase,
    useClient,
    useUnitOfWork,
} from "./test-fixtures/index.js";
import { runHexaiMigrations } from "./run-hexai-migrations.js";

const DATABASE = "test_hexai__event_store";

class TestEvent extends Message<{ value: string }> {
    static readonly type = "TestEvent";
}

const TEST_VALUES = {
    FIRST: "first",
    SECOND: "second",
    THIRD: "third",
    FOURTH: "fourth",
} as const;

function createTestEvent(value: string): TestEvent {
    return new TestEvent({ value });
}

function createTestEvents(...values: string[]): TestEvent[] {
    return values.map(createTestEvent);
}

describe("PostgresEventStore", () => {
    const databaseUrl = useDatabase(DATABASE);

    beforeAll(async () => {
        await runHexaiMigrations(databaseUrl.toString());
    });

    const conn = useClient(DATABASE);
    const uow = useUnitOfWork(DATABASE);
    const eventStore = new PostgresEventStore(uow);

    beforeEach(async () => {
        await conn.query(`TRUNCATE TABLE hexai__events RESTART IDENTITY`);
    });

    describe("store", () => {
        test("stores a single event and returns stored event with position", async () => {
            const testValue = "hello";
            const event = createTestEvent(testValue);

            const stored = await eventStore.store(event);

            expect(stored.position).toBe(1);
            expect(stored.event.getMessageType()).toBe(TestEvent.type);
            expect(stored.event.getPayload()).toEqual({ value: testValue });
        });

        test("assigns sequential positions to multiple events", async () => {
            const [event1, event2, event3] = createTestEvents(
                TEST_VALUES.FIRST,
                TEST_VALUES.SECOND,
                TEST_VALUES.THIRD
            );

            const stored1 = await eventStore.store(event1);
            const stored2 = await eventStore.store(event2);
            const stored3 = await eventStore.store(event3);

            expect(stored1.position).toBe(1);
            expect(stored2.position).toBe(2);
            expect(stored3.position).toBe(3);
        });

        test("preserves message headers", async () => {
            const event = createTestEvent("test");
            const originalMessageId = event.getMessageId();

            const stored = await eventStore.store(event);

            expect(stored.event.getMessageId()).toBe(originalMessageId);
        });
    });

    describe("storeAll", () => {
        test("stores multiple events in a single call", async () => {
            const events = createTestEvents(
                TEST_VALUES.FIRST,
                TEST_VALUES.SECOND,
                TEST_VALUES.THIRD
            );

            const storedEvents = await eventStore.storeAll(events);

            expect(storedEvents).toHaveLength(3);
            expect(storedEvents[0].position).toBe(1);
            expect(storedEvents[1].position).toBe(2);
            expect(storedEvents[2].position).toBe(3);
        });

        test("returns empty array when given empty array", async () => {
            const storedEvents = await eventStore.storeAll([]);

            expect(storedEvents).toEqual([]);
        });
    });

    describe("fetch", () => {
        test("returns events after specified position", async () => {
            await eventStore.storeAll(
                createTestEvents(
                    TEST_VALUES.FIRST,
                    TEST_VALUES.SECOND,
                    TEST_VALUES.THIRD
                )
            );

            const result = await eventStore.fetch(1);

            expect(result.events).toHaveLength(2);
            expect(result.events[0].position).toBe(2);
            expect(result.events[1].position).toBe(3);
        });

        test("returns all events when afterPosition is 0", async () => {
            await eventStore.storeAll(
                createTestEvents(TEST_VALUES.FIRST, TEST_VALUES.SECOND)
            );

            const result = await eventStore.fetch(0);

            expect(result.events).toHaveLength(2);
            expect(result.events[0].position).toBe(1);
            expect(result.events[1].position).toBe(2);
        });

        test("respects limit parameter", async () => {
            await eventStore.storeAll(
                createTestEvents(
                    TEST_VALUES.FIRST,
                    TEST_VALUES.SECOND,
                    TEST_VALUES.THIRD,
                    TEST_VALUES.FOURTH
                )
            );

            const result = await eventStore.fetch(0, 2);

            expect(result.events).toHaveLength(2);
            expect(result.events[0].position).toBe(1);
            expect(result.events[1].position).toBe(2);
        });

        test("returns lastPosition as the highest position in the store", async () => {
            await eventStore.storeAll(
                createTestEvents(
                    TEST_VALUES.FIRST,
                    TEST_VALUES.SECOND,
                    TEST_VALUES.THIRD
                )
            );

            const result = await eventStore.fetch(0, 1);

            expect(result.events).toHaveLength(1);
            expect(result.lastPosition).toBe(3);
        });

        test("returns empty events but correct lastPosition when no events match", async () => {
            await eventStore.storeAll(
                createTestEvents(TEST_VALUES.FIRST, TEST_VALUES.SECOND)
            );

            const result = await eventStore.fetch(2);

            expect(result.events).toHaveLength(0);
            expect(result.lastPosition).toBe(2);
        });

        test("returns lastPosition as 0 when store is empty", async () => {
            const result = await eventStore.fetch(0);

            expect(result.events).toHaveLength(0);
            expect(result.lastPosition).toBe(0);
        });
    });

    describe("getLastPosition", () => {
        test("returns 0 when store is empty", async () => {
            const lastPosition = await eventStore.getLastPosition();

            expect(lastPosition).toBe(0);
        });

        test("returns the position of the last stored event", async () => {
            await eventStore.storeAll(
                createTestEvents(
                    TEST_VALUES.FIRST,
                    TEST_VALUES.SECOND,
                    TEST_VALUES.THIRD
                )
            );

            const lastPosition = await eventStore.getLastPosition();

            expect(lastPosition).toBe(3);
        });
    });

    describe("stream", () => {
        test("yields all events after specified position", async () => {
            await eventStore.storeAll(
                createTestEvents(
                    TEST_VALUES.FIRST,
                    TEST_VALUES.SECOND,
                    TEST_VALUES.THIRD
                )
            );

            const events = [];
            for await (const event of eventStore.stream(1, 10)) {
                events.push(event);
            }

            expect(events).toHaveLength(2);
            expect(events[0].position).toBe(2);
            expect(events[1].position).toBe(3);
        });

        test("yields all events when afterPosition is 0", async () => {
            await eventStore.storeAll(
                createTestEvents(TEST_VALUES.FIRST, TEST_VALUES.SECOND)
            );

            const events = [];
            for await (const event of eventStore.stream(0, 10)) {
                events.push(event);
            }

            expect(events).toHaveLength(2);
            expect(events[0].position).toBe(1);
            expect(events[1].position).toBe(2);
        });

        test("yields events in multiple batches", async () => {
            await eventStore.storeAll(
                createTestEvents(
                    TEST_VALUES.FIRST,
                    TEST_VALUES.SECOND,
                    TEST_VALUES.THIRD,
                    TEST_VALUES.FOURTH
                )
            );

            const events = [];
            for await (const event of eventStore.stream(0, 2)) {
                events.push(event);
            }

            expect(events).toHaveLength(4);
            expect(events[0].position).toBe(1);
            expect(events[3].position).toBe(4);
        });

        test("handles early termination without unhandled rejection", async () => {
            await eventStore.storeAll(
                createTestEvents(
                    TEST_VALUES.FIRST,
                    TEST_VALUES.SECOND,
                    TEST_VALUES.THIRD,
                    TEST_VALUES.FOURTH
                )
            );

            const events = [];
            for await (const event of eventStore.stream(0, 2)) {
                events.push(event);
                if (events.length === 1) break;
            }

            expect(events).toHaveLength(1);
            expect(events[0].position).toBe(1);
        });

        test("prefetches next batch before yielding current batch", async () => {
            await eventStore.storeAll(
                createTestEvents(
                    TEST_VALUES.FIRST,
                    TEST_VALUES.SECOND,
                    TEST_VALUES.THIRD,
                    TEST_VALUES.FOURTH
                )
            );

            const timeline: string[] = [];
            const original = uow.withClient.bind(uow);
            const spy = vi.spyOn(uow, "withClient").mockImplementation(
                async <T>(fn: (client: any) => Promise<T>): Promise<T> => {
                    timeline.push("fetch-start");
                    const result = await original(fn);
                    timeline.push("fetch-end");
                    return result;
                }
            );

            for await (const event of eventStore.stream(0, 2)) {
                timeline.push(`event-${event.position}`);
            }

            spy.mockRestore();

            const secondFetchStart = timeline.indexOf(
                "fetch-start",
                timeline.indexOf("fetch-start") + 1
            );
            const firstEventYield = timeline.indexOf("event-1");

            expect(secondFetchStart).toBeGreaterThan(-1);
            expect(secondFetchStart).toBeLessThan(firstEventYield);
        });

        test("yields nothing when no events exist after position", async () => {
            await eventStore.storeAll(
                createTestEvents(TEST_VALUES.FIRST, TEST_VALUES.SECOND)
            );

            const events = [];
            for await (const event of eventStore.stream(2, 10)) {
                events.push(event);
            }

            expect(events).toHaveLength(0);
        });

        test("yields nothing when store is empty", async () => {
            const events = [];
            for await (const event of eventStore.stream(0, 10)) {
                events.push(event);
            }

            expect(events).toHaveLength(0);
        });
    });

    describe("event deserialization", () => {
        test("deserializes event payload correctly", async () => {
            const testValue = "deserialization-test";
            const event = createTestEvent(testValue);
            await eventStore.store(event);

            const result = await eventStore.fetch(0);

            expect(result.events[0].event.getPayload()).toEqual({
                value: testValue,
            });
        });

        test("deserializes event headers correctly", async () => {
            const event = createTestEvent("headers-test");
            const originalId = event.getMessageId();
            const originalType = event.getMessageType();
            await eventStore.store(event);

            const result = await eventStore.fetch(0);
            const deserializedEvent = result.events[0].event;

            expect(deserializedEvent.getMessageId()).toBe(originalId);
            expect(deserializedEvent.getMessageType()).toBe(originalType);
        });
    });
});
