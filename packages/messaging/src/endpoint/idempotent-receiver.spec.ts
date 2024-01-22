import { beforeEach, describe, expect, it, Mock, test, vi } from "vitest";
import { ApplicationContextAware, UnitOfWorkHolder } from "@hexai/core";
import { DummyMessage, SqliteUnitOfWork } from "@hexai/core/test";
import * as sqlite from "sqlite";
import sqlite3 from "sqlite3";

import { SqliteIdempotencySupport } from "@/test";
import { IdempotencySupportHolder } from "@/types";
import { MessageHandlerObject } from "./message-handler";
import { IdempotencySupport } from "./idempotency-support";
import { IdempotentReceiver } from "./idempotent-receiver";

describe("IdempotentReceiver", () => {
    let applicationContext: UnitOfWorkHolder & IdempotencySupportHolder;
    let db: sqlite.Database;
    let idempotencySupport: IdempotencySupport;
    const mockHandler: MessageHandlerObject & ApplicationContextAware = {
        handle: vi.fn(),
        setApplicationContext: vi.fn(),
    };
    const receiver = new IdempotentReceiver("key", mockHandler);
    const message = DummyMessage.create();

    beforeEach(async () => {
        vi.resetAllMocks();
        vi.restoreAllMocks();

        db = await sqlite.open({
            filename: ":memory:",
            driver: sqlite3.Database,
        });
        await db.exec(`
            CREATE TABLE IF NOT EXISTS test (
                value TEXT NOT NULL
            );
        `);
        idempotencySupport = new SqliteIdempotencySupport(db);

        applicationContext = {
            getIdempotencySupport() {
                return idempotencySupport;
            },
            getUnitOfWork() {
                return new SqliteUnitOfWork(db);
            },
        };
        receiver.setApplicationContext(applicationContext);

        return async () => {
            await db.close();
        };
    });

    test("error when no support provided", async () => {
        await expect(
            new IdempotentReceiver("key", mockHandler).handle(message)
        ).rejects.toThrowError("idempotency support not provided");
        expect(mockHandler.handle).not.toHaveBeenCalled();
    });

    it("injects application context to delegate", async () => {
        await receiver.handle(message);

        expect(mockHandler.setApplicationContext).toHaveBeenCalledWith(
            applicationContext
        );
    });

    it("does not delegate when message is duplicate", async () => {
        await idempotencySupport.markAsProcessed("key", message);

        await receiver.handle(message);

        expect(mockHandler.handle).not.toHaveBeenCalled();
    });

    it("delegates when message is not duplicate", async () => {
        (mockHandler.handle as Mock).mockReturnValueOnce("result");

        const result = await receiver.handle(message);

        expect(result).toBe("result");
    });

    it("marks message as processed after delegate", async () => {
        await receiver.handle(message);

        await expect(
            idempotencySupport.isDuplicate("key", message)
        ).resolves.toBe(true);
    });

    it("does not mark message as processed when delegate throws error", async () => {
        (mockHandler.handle as Mock).mockRejectedValueOnce(new Error("error"));

        await expect(receiver.handle(message)).rejects.toThrowError("error");
        await expect(
            idempotencySupport.isDuplicate("key", message)
        ).resolves.toBe(false);
    });

    it("rolls back transaction when marking fails", async () => {
        (mockHandler.handle as Mock).mockImplementation(async () => {
            await db.run("INSERT INTO test (value) VALUES (?)", ["value"]);
        });
        vi.spyOn(idempotencySupport, "markAsProcessed").mockRejectedValueOnce(
            new Error("marking failed")
        );

        await expect(receiver.handle(message)).rejects.toThrowError(
            "marking failed"
        );
        await expect(
            db.get("SELECT COUNT(*) as count FROM test")
        ).resolves.toEqual({ count: 0 });
    });
});
