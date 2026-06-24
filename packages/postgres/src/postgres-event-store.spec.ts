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
const MIGRATION_DATABASE = "test_hexai__event_store_migration";
const CUSTOM_EVENT_TABLE = "hexai__custom_events";
const CUSTOM_POSITION_COUNTER_TABLE = "hexai__custom_events_position_counter";
const EXPLICIT_POSITION_COUNTER_TABLE = "hexai__explicit_position_counter";
const MISSING_POSITION_COUNTER_TABLE = "hexai__missing_position_counter";

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
        await resetPositionCounter(conn, "hexai__event_position_counter");
        await conn.query(`DROP TABLE IF EXISTS ${CUSTOM_EVENT_TABLE}`);
        await conn.query(
            `DROP TABLE IF EXISTS ${CUSTOM_POSITION_COUNTER_TABLE}`
        );
        await conn.query(
            `DROP TABLE IF EXISTS ${EXPLICIT_POSITION_COUNTER_TABLE}`
        );
        await conn.query(
            `DROP TABLE IF EXISTS ${MISSING_POSITION_COUNTER_TABLE}`
        );
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

        test("reuses positions assigned by a rolled-back transaction", async () => {
            await expect(
                uow.scope(async () => {
                    await eventStore.store(createTestEvent(TEST_VALUES.FIRST));
                    throw new Error("rollback event append");
                })
            ).rejects.toThrow("rollback event append");

            const stored = await eventStore.store(
                createTestEvent(TEST_VALUES.SECOND)
            );

            expect(stored.position).toBe(1);
            expect(
                (await eventStore.fetch(0)).events.map((event) => ({
                    position: event.position,
                    payload: event.event.getPayload(),
                }))
            ).toEqual([
                {
                    position: 1,
                    payload: { value: TEST_VALUES.SECOND },
                },
            ]);
        });

        test("fails fast when the position counter row is missing", async () => {
            await conn.query(
                `DELETE FROM hexai__event_position_counter WHERE id = 1`
            );

            await expect(
                eventStore.store(createTestEvent(TEST_VALUES.FIRST))
            ).rejects.toThrow(
                `Event position counter "hexai__event_position_counter" is not initialized`
            );
        });

        test("explains how to fix a missing position counter table", async () => {
            const storeWithMissingCounter = new PostgresEventStore(uow, {
                positionCounterTableName: MISSING_POSITION_COUNTER_TABLE,
            });

            await expect(
                storeWithMissingCounter.store(
                    createTestEvent(TEST_VALUES.FIRST)
                )
            ).rejects.toThrow(
                `Event position counter table "${MISSING_POSITION_COUNTER_TABLE}" does not exist`
            );
        });
    });

    describe("custom tables", () => {
        test("uses a table-scoped counter by default", async () => {
            await createEventTable(conn, CUSTOM_EVENT_TABLE);
            await createPositionCounterTable(
                conn,
                CUSTOM_POSITION_COUNTER_TABLE
            );
            await setPositionCounter(conn, "hexai__event_position_counter", 41);
            const customEventStore = new PostgresEventStore(uow, {
                tableName: CUSTOM_EVENT_TABLE,
            });

            const stored = await customEventStore.store(
                createTestEvent(TEST_VALUES.FIRST)
            );

            expect(stored.position).toBe(1);
            expect(
                await readPositionCounter(conn, "hexai__event_position_counter")
            ).toBe(41);
            expect(
                await readPositionCounter(conn, CUSTOM_POSITION_COUNTER_TABLE)
            ).toBe(1);
        });

        test("supports an explicit counter table override", async () => {
            await createEventTable(conn, CUSTOM_EVENT_TABLE);
            await createPositionCounterTable(
                conn,
                EXPLICIT_POSITION_COUNTER_TABLE
            );
            const customEventStore = new PostgresEventStore(uow, {
                tableName: CUSTOM_EVENT_TABLE,
                positionCounterTableName: EXPLICIT_POSITION_COUNTER_TABLE,
            });

            const stored = await customEventStore.store(
                createTestEvent(TEST_VALUES.FIRST)
            );

            expect(stored.position).toBe(1);
            expect(
                await readPositionCounter(conn, EXPLICIT_POSITION_COUNTER_TABLE)
            ).toBe(1);
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
            const spy = vi
                .spyOn(uow, "withClient")
                .mockImplementation(
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

describe("PostgresEventStore migrations", () => {
    const databaseUrl = useDatabase(MIGRATION_DATABASE);
    const conn = useClient(MIGRATION_DATABASE);
    const uow = useUnitOfWork(MIGRATION_DATABASE);

    beforeEach(async () => {
        await conn.query(`DROP TABLE IF EXISTS hexai__events CASCADE`);
        await conn.query(
            `DROP TABLE IF EXISTS hexai__event_position_counter CASCADE`
        );
        await conn.query(
            `DROP TABLE IF EXISTS hexai__migrations_hexai CASCADE`
        );
    });

    test("upgrades an existing serial-position event table to counter allocation", async () => {
        await createLegacyEventStoreSchema(conn);

        await runHexaiMigrations(databaseUrl.toString());

        await expectCounterMigrationState(conn, 2);

        const eventStore = new PostgresEventStore(uow);
        const stored = await eventStore.store(
            createTestEvent(TEST_VALUES.THIRD)
        );

        expect(stored.position).toBe(3);
    });

    test("can rerun the counter migration after the schema change is applied but not recorded", async () => {
        await createLegacyEventStoreSchema(conn);
        await runHexaiMigrations(databaseUrl.toString());
        await conn.query(
            `DELETE FROM hexai__migrations_hexai WHERE name = '02_event_position_counter'`
        );

        await runHexaiMigrations(databaseUrl.toString());

        await expectCounterMigrationState(conn, 2);
        const eventStore = new PostgresEventStore(uow);
        const stored = await eventStore.store(
            createTestEvent(TEST_VALUES.THIRD)
        );
        expect(stored.position).toBe(3);
    });
});

async function createLegacyEventStoreSchema(
    conn: ReturnType<typeof useClient>
): Promise<void> {
    await conn.query(`
        CREATE TABLE hexai__migrations_hexai (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            run_on TIMESTAMP NOT NULL DEFAULT NOW()
        )
    `);
    await conn.query(
        `INSERT INTO hexai__migrations_hexai (name) VALUES ('01_postgres_event_store')`
    );
    await conn.query(`
        CREATE TABLE hexai__events (
            position BIGSERIAL PRIMARY KEY,
            message_type TEXT NOT NULL,
            headers JSONB NOT NULL,
            payload JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
    await conn.query(`
        INSERT INTO hexai__events (message_type, headers, payload)
        VALUES
            ('${TestEvent.type}', '{"headers":{"type":"${TestEvent.type}"}}', '{"value":"${TEST_VALUES.FIRST}"}'),
            ('${TestEvent.type}', '{"headers":{"type":"${TestEvent.type}"}}', '{"value":"${TEST_VALUES.SECOND}"}')
    `);
}

async function expectCounterMigrationState(
    conn: ReturnType<typeof useClient>,
    lastPosition: number
): Promise<void> {
    const counter = await conn.query<{ last_position: string }>(
        `SELECT last_position FROM hexai__event_position_counter WHERE id = 1`
    );
    expect(Number(counter.rows[0].last_position)).toBe(lastPosition);

    const positionDefault = await conn.query<{
        column_default: string | null;
    }>(
        `SELECT column_default
         FROM information_schema.columns
         WHERE table_name = 'hexai__events'
           AND column_name = 'position'`
    );
    expect(positionDefault.rows[0].column_default).toBeNull();
}

async function createEventTable(
    conn: ReturnType<typeof useClient>,
    tableName: string
): Promise<void> {
    await conn.query(`
        CREATE TABLE ${tableName} (
            position BIGINT PRIMARY KEY,
            message_type TEXT NOT NULL,
            headers JSONB NOT NULL,
            payload JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
}

async function createPositionCounterTable(
    conn: ReturnType<typeof useClient>,
    tableName: string
): Promise<void> {
    await conn.query(`
        CREATE TABLE ${tableName} (
            id INTEGER PRIMARY KEY DEFAULT 1,
            last_position BIGINT NOT NULL DEFAULT 0,
            CONSTRAINT ${tableName}_singleton CHECK (id = 1)
        )
    `);
    await resetPositionCounter(conn, tableName);
}

async function resetPositionCounter(
    conn: ReturnType<typeof useClient>,
    tableName: string
): Promise<void> {
    await setPositionCounter(conn, tableName, 0);
}

async function setPositionCounter(
    conn: ReturnType<typeof useClient>,
    tableName: string,
    position: number
): Promise<void> {
    await conn.query(
        `INSERT INTO ${tableName} (id, last_position)
         VALUES (1, $1)
         ON CONFLICT (id) DO UPDATE SET last_position = EXCLUDED.last_position`,
        [position]
    );
}

async function readPositionCounter(
    conn: ReturnType<typeof useClient>,
    tableName: string
): Promise<number> {
    const result = await conn.query<{ last_position: string }>(
        `SELECT last_position FROM ${tableName} WHERE id = 1`
    );
    return Number(result.rows[0].last_position);
}
