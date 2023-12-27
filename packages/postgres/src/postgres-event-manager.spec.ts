import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import * as pg from "pg";

import { OutboxEventPublisher, PublishedEventTracker } from "@hexai/core/infra";
import { Event } from "@hexai/core/message";
import { DummyEvent } from "@hexai/core/test";

import { DB_URL } from "./config";
import { postgresUnitOfWork } from "./postgres-unit-of-work";
import { DatabaseManager, replaceDatabaseName, TableManager } from "./helpers";
import { runMigration } from "./run-migration";

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

const DATABASE = "test_hexai__event_publisher";
const URL = replaceDatabaseName(DATABASE, DB_URL);

describe("event publisher", () => {
    const eventManager = new PostgresEventManager();
    const conn = new pg.Client(URL);
    const dbManager = new DatabaseManager(replaceDatabaseName("postgres", URL));
    const tableManager = new TableManager(conn);
    postgresUnitOfWork.bind(() => conn);

    beforeAll(async () => {
        await dbManager.createDatabase(DATABASE);
        await conn.connect();

        await runMigration({
            url: URL,
        });
        return async () => {
            await conn.end();

            await dbManager.dropDatabase(DATABASE);
            await dbManager.close();
        };
    });

    beforeEach(async () => {
        await tableManager.truncateAllTables();
        vi.resetAllMocks();
        vi.restoreAllMocks();
    });

    test("publishing no events", async () => {
        vi.spyOn(postgresUnitOfWork, "wrap");
        await eventManager.publish([]);

        expect(postgresUnitOfWork.wrap).toHaveBeenCalledTimes(0);
    });

    test("publishing one event", async () => {
        const event = DummyEvent.create();

        await eventManager.publish([event]);
    });
});
