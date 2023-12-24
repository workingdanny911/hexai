import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    test,
    vi,
} from "vitest";
import * as pg from "pg";

import { OutboxEventPublisher, PublishedEventTracker } from "Hexai/infra";
import { Event } from "Hexai/message";
import { DummyEvent } from "Hexai/test";
import { DB_URL } from "Hexai/config";
import { postgresUnitOfWork } from "./postgres-unit-of-work";

class PostgresEventManager
    implements OutboxEventPublisher, PublishedEventTracker
{
    async publish(events: Event[]): Promise<void> {
        if (events.length === 0) {
            return;
        }
    }

    getUnpublishedEvents(
        batchSize?: number | undefined
    ): Promise<[number, Event[]]> {
        throw new Error("Method not implemented.");
    }

    markEventsAsPublished(
        fromPosition: number,
        numEvents: number
    ): Promise<void> {
        throw new Error("Method not implemented.");
    }
}

describe("event publisher", () => {
    const eventManager = new PostgresEventManager();
    const conn = new pg.Client({
        connectionString: DB_URL,
    });
    postgresUnitOfWork.bind(() => conn);

    beforeAll(async () => {
        await conn.connect();
    });

    afterAll(async () => {
        await conn.end();
    });

    beforeEach(async () => {
        await conn.query(`TRUNCATE TABLE "hexai__outbox" RESTART IDENTITY`);
        vi.resetAllMocks();
    });

    test("publishing no events", async () => {
        await eventManager.publish([]);

        expect(postgresUnitOfWork.wrap).toHaveBeenCalledTimes(0);
    });

    test("publishing one event", async () => {
        const event = DummyEvent.create();

        await eventManager.publish([event]);
    });
});
