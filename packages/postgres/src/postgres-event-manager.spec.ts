import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import * as pg from "pg";

import { EventPublisher, Message, PublishedMessageTracker } from "@hexai/core";
import { DummyMessage } from "@hexai/core/test";

import { DB_URL } from "./config";
import { postgresUnitOfWork } from "./postgres-unit-of-work";
import { DatabaseManager, replaceDatabaseName, TableManager } from "./helpers";
import { runMigration } from "./run-migration";

class PostgresEventManager implements EventPublisher, PublishedMessageTracker {
    async publish(...events: Message[]): Promise<void> {
        if (events.length === 0) {
            return;
        }
    }

    getUnpublishedMessages(
        batchSize?: number | undefined
    ): Promise<[number, Message[]]> {
        throw new Error("Method not implemented.");
    }

    markMessagesAsPublished(
        fromPosition: number,
        number: number
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
        await eventManager.publish();

        expect(postgresUnitOfWork.wrap).toHaveBeenCalledTimes(0);
    });

    test("publishing one event", async () => {
        const event = DummyMessage.create();

        await eventManager.publish(event);
    });
});
