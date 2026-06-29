import { beforeAll, beforeEach, describe, expect, test } from "vitest";

import {
    Message,
    type EventSubscriber,
    type StoredEvent,
    type SubscribableEventPublisher,
} from "@hexaijs/core";

import { PostgresEventStore } from "./postgres-event-store.js";
import {
    PostgresTransactionalEventStoreSink,
    TransactionalEventStoreSinkClosedError,
    attachPostgresEventStoreSink,
} from "./postgres-transactional-event-store-sink.js";
import { runHexaiMigrations } from "./run-hexai-migrations.js";
import {
    useClient,
    useDatabase,
    useUnitOfWork,
} from "./test-fixtures/index.js";

const DATABASE = "test_hexai__transactional_event_store_sink";

class EventStoreSinkEvent extends Message<{ value: string }> {
    static readonly type = "EventStoreSinkEvent";
}

function event(value: string): EventStoreSinkEvent {
    return new EventStoreSinkEvent({ value });
}

interface StoredEventSummary {
    position: number;
    value: string;
}

function summarizeStoredEvents(
    storedEvents: StoredEvent[]
): StoredEventSummary[] {
    return storedEvents.map((stored) => ({
        position: stored.position,
        value: stored.event.getPayload().value,
    }));
}

class TestEventPublisher implements SubscribableEventPublisher<Message> {
    private readonly subscribers = new Set<EventSubscriber<Message>>();

    subscribe(subscriber: EventSubscriber<Message>): () => void {
        this.subscribers.add(subscriber);
        return () => {
            this.subscribers.delete(subscriber);
        };
    }

    async publish(...events: Message[]): Promise<void> {
        for (const event of events) {
            await Promise.all(
                [...this.subscribers].map((subscriber) => subscriber(event))
            );
        }
    }
}

describe("PostgresTransactionalEventStoreSink", () => {
    const databaseUrl = useDatabase(DATABASE);

    beforeAll(async () => {
        await runHexaiMigrations(databaseUrl.toString());
    });

    const conn = useClient(DATABASE);
    const uow = useUnitOfWork(DATABASE);
    const projectionUnitOfWork = useUnitOfWork(DATABASE);
    const projectionEventStore = new PostgresEventStore(projectionUnitOfWork);
    const sink = new PostgresTransactionalEventStoreSink(uow);

    beforeEach(async () => {
        await conn.query(`TRUNCATE TABLE hexai__events RESTART IDENTITY`);
        await resetPositionCounter();
    });

    test("keeps events invisible until the surrounding transaction commits", async () => {
        await uow.scope(async () => {
            await sink.accept(event("first"), event("second"));

            // A projection worker uses its own connection. It must not observe
            // buffered events or an advanced counter before the command commits.
            expect(await readCommittedEvents()).toEqual([]);
            expect(await readPositionCounter()).toBe(0);
        });

        expect(await readCommittedEvents()).toEqual([
            { position: 1, value: "first" },
            { position: 2, value: "second" },
        ]);
        expect(await readPositionCounter()).toBe(2);
    });

    test("notifies onStored with stored positions before the transaction commits", async () => {
        const batches: StoredEventSummary[][] = [];
        const callbackSink = new PostgresTransactionalEventStoreSink(uow, {
            onStored: async (storedEvents) => {
                batches.push(summarizeStoredEvents(storedEvents));

                expect(await readCommittedEvents()).toEqual([]);
            },
        });

        await uow.scope(async () => {
            await callbackSink.accept(event("first"), event("second"));

            expect(batches).toEqual([]);
        });

        expect(batches).toEqual([
            [
                { position: 1, value: "first" },
                { position: 2, value: "second" },
            ],
        ]);
        expect(await readCommittedEvents()).toEqual([
            { position: 1, value: "first" },
            { position: 2, value: "second" },
        ]);
    });

    test("drops accepted events when the transaction rolls back", async () => {
        await expect(
            uow.scope(async () => {
                await sink.accept(event("rolled-back"));

                throw new Error("command failed");
            })
        ).rejects.toThrow("command failed");

        expect(await readCommittedEvents()).toEqual([]);
        expect(await readPositionCounter()).toBe(0);
    });

    test("does not call onStored when the transaction rolls back before drain", async () => {
        const batches: StoredEventSummary[][] = [];
        const callbackSink = new PostgresTransactionalEventStoreSink(uow, {
            onStored: (storedEvents) => {
                batches.push(summarizeStoredEvents(storedEvents));
            },
        });

        await expect(
            uow.scope(async () => {
                await callbackSink.accept(event("rolled-back"));

                throw new Error("command failed");
            })
        ).rejects.toThrow("command failed");

        expect(batches).toEqual([]);
        expect(await readCommittedEvents()).toEqual([]);
        expect(await readPositionCounter()).toBe(0);
    });

    test("rolls back accepted events when onStored rejects", async () => {
        const callbackSink = new PostgresTransactionalEventStoreSink(uow, {
            onStored: async () => {
                throw new Error("onStored failed");
            },
        });

        await expect(
            uow.scope(async () => {
                await callbackSink.accept(event("should-roll-back"));
            })
        ).rejects.toThrow("onStored failed");

        expect(await readCommittedEvents()).toEqual([]);
        expect(await readPositionCounter()).toBe(0);
    });

    test("does not depend on the projection event store unit of work", async () => {
        await uow.scope(async () => {
            await sink.accept(event("from-command-uow"));
        });

        expect(await fetchProjectedEvents()).toEqual([
            { position: 1, value: "from-command-uow" },
        ]);
    });

    test("notifies onStored once per drained append batch", async () => {
        const batches: StoredEventSummary[][] = [];
        let callbackSink!: PostgresTransactionalEventStoreSink;
        callbackSink = new PostgresTransactionalEventStoreSink(uow, {
            onStored: async (storedEvents) => {
                batches.push(summarizeStoredEvents(storedEvents));

                if (batches.length === 1) {
                    await callbackSink.accept(event("from-callback"));
                }
            },
        });

        await uow.scope(async () => {
            await callbackSink.accept(event("from-handler"));
        });

        expect(batches).toEqual([
            [{ position: 1, value: "from-handler" }],
            [{ position: 2, value: "from-callback" }],
        ]);
        expect(await readCommittedEvents()).toEqual([
            { position: 1, value: "from-handler" },
            { position: 2, value: "from-callback" },
        ]);
    });

    test("drains events published by main-phase beforeCommit hooks", async () => {
        await uow.scope(async () => {
            await sink.accept(event("from-handler"));

            uow.beforeCommit(async () => {
                await sink.accept(event("from-commit-hook"));
            });
        });

        expect(await readCommittedEvents()).toEqual([
            { position: 1, value: "from-handler" },
            { position: 2, value: "from-commit-hook" },
        ]);
    });

    test("preserves accept order when a concurrent accept runs before the first accept resumes", async () => {
        const orderingSink = new PostgresTransactionalEventStoreSink(uow);

        await uow.scope(async () => {
            const firstAccept = orderingSink.accept(event("first"));

            await orderingSink.accept(event("second"));
            await firstAccept;
        });

        expect(await readCommittedEvents()).toEqual([
            { position: 1, value: "first" },
            { position: 2, value: "second" },
        ]);
    });

    test("attaches itself to a subscribable event publisher", async () => {
        const publisher = new TestEventPublisher();
        const detach = attachPostgresEventStoreSink(publisher, uow);

        await uow.scope(async () => {
            await publisher.publish(event("from-publisher"));

            expect(await readCommittedEvents()).toEqual([]);
        });

        expect(await fetchProjectedEvents()).toEqual([
            { position: 1, value: "from-publisher" },
        ]);

        detach();

        await uow.scope(async () => {
            await publisher.publish(event("detached"));
        });

        expect(await fetchProjectedEvents()).toEqual([
            { position: 1, value: "from-publisher" },
        ]);
    });

    test("fails instead of losing events accepted after the sink drain completed", async () => {
        await expect(
            uow.scope(async () => {
                await sink.accept(event("already-drained"));

                uow.beforeCommit(async () => {
                    await sink.accept(event("too-late"));
                }, { phase: "drain" });
            })
        ).rejects.toThrow(TransactionalEventStoreSinkClosedError);

        expect(await readCommittedEvents()).toEqual([]);
        expect(await readPositionCounter()).toBe(0);
    });

    test("fails instead of registering its first drain hook too late", async () => {
        await expect(
            uow.scope(async () => {
                await uow.withClient(async () => {});

                uow.beforeCommit(async () => {
                    await sink.accept(event("first-published-too-late"));
                }, { phase: "drain" });
            })
        ).rejects.toThrow(TransactionalEventStoreSinkClosedError);

        expect(await readCommittedEvents()).toEqual([]);
        expect(await readPositionCounter()).toBe(0);
    });

    test("requires an active transaction scope", async () => {
        await expect(sink.accept(event("outside"))).rejects.toThrow(
            "outside of a transaction scope"
        );
    });

    async function readCommittedEvents(): Promise<
        Array<{ position: number; value: string }>
    > {
        const result = await conn.query<{
            position: string;
            payload: { value: string };
        }>(
            `SELECT position, payload
             FROM hexai__events
             ORDER BY position ASC`
        );

        return result.rows.map((row) => ({
            position: Number(row.position),
            value: row.payload.value,
        }));
    }

    async function readPositionCounter(): Promise<number> {
        const result = await conn.query<{ last_position: string }>(
            `SELECT last_position
             FROM hexai__event_position_counter
             WHERE id = 1`
        );

        return Number(result.rows[0].last_position);
    }

    async function fetchProjectedEvents(): Promise<
        Array<{ position: number; value: string }>
    > {
        const result = await projectionEventStore.fetch(0);

        return result.events.map((stored) => ({
            position: stored.position,
            value: stored.event.getPayload().value,
        }));
    }

    async function resetPositionCounter(): Promise<void> {
        await conn.query(
            `INSERT INTO hexai__event_position_counter (id, last_position)
             VALUES (1, 0)
             ON CONFLICT (id)
             DO UPDATE SET last_position = EXCLUDED.last_position`
        );
    }
});
