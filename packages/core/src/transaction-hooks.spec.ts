import { describe, expect, test } from "vitest";

import {
    BeforeCommitPhaseClosedError,
    TransactionHooks,
} from "./transaction-hooks.js";

function createCommitScenario() {
    const events: string[] = [];
    const hooks = new TransactionHooks();
    const record = (event: string) => () => { events.push(event); };
    const executeCommit = () =>
        hooks.executeCommit(record("commit"), record("rollback"));

    return {
        events,
        executeCommit,
        hooks,
        record,
    };
}

describe("TransactionHooks", () => {
    test("runs drain beforeCommit hooks after all main hooks and before commit", async () => {
        const { events, executeCommit, hooks, record } = createCommitScenario();

        hooks.addBeforeCommit(record("drain-1"), "drain");
        hooks.addBeforeCommit(record("main-1"));
        hooks.addBeforeCommit(record("main-2"), "main");
        hooks.addBeforeCommit(record("drain-2"), "drain");

        await executeCommit();

        expect(events).toEqual([
            "main-1",
            "main-2",
            "drain-1",
            "drain-2",
            "commit",
        ]);
    });

    test("allows a main hook to register a drain hook for the same transaction", async () => {
        const { events, executeCommit, hooks, record } = createCommitScenario();

        hooks.addBeforeCommit(() => {
            events.push("main");
            hooks.addBeforeCommit(record("drain"), "drain");
        });

        await executeCommit();

        expect(events).toEqual(["main", "drain", "commit"]);
    });

    test("rejects main beforeCommit registration while main hooks are running", async () => {
        const { executeCommit, hooks } = createCommitScenario();

        hooks.addBeforeCommit(() => {
            hooks.addBeforeCommit(() => {}, "main");
        });

        await expect(executeCommit()).rejects.toBeInstanceOf(
            BeforeCommitPhaseClosedError
        );
    });

    test("rejects drain beforeCommit registration while drain hooks are running", async () => {
        const { executeCommit, hooks } = createCommitScenario();

        hooks.addBeforeCommit(() => {
            hooks.addBeforeCommit(() => {}, "drain");
        }, "drain");

        await expect(executeCommit()).rejects.toBeInstanceOf(
            BeforeCommitPhaseClosedError
        );
    });

    test("rolls back and skips commit when a drain hook fails", async () => {
        const { events, executeCommit, hooks, record } = createCommitScenario();

        hooks.addBeforeCommit(record("main"));
        hooks.addBeforeCommit(() => {
            events.push("drain");
            throw new Error("drain failure");
        }, "drain");

        await expect(executeCommit()).rejects.toThrow("drain failure");
        expect(events).toEqual(["main", "drain", "rollback"]);
    });
});
