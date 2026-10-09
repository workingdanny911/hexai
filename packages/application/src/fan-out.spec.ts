import { describe, expect, test, vi } from "vitest";
import { waitForTicks } from "@hexaijs/core/test";

import { fanOut } from "./fan-out.js";
import { createDeferred, trackSettlement } from "./test/index.js";

describe("fanOut", () => {
    test("waits for every started invocation to settle before rejecting", async () => {
        const slowItemGate = createDeferred();
        let isSlowItemFinished = false;
        const invocations = {
            failing: async () => {
                throw new Error("fast failure");
            },
            slow: async () => {
                await slowItemGate.promise;
                isSlowItemFinished = true;
            },
        };

        const fanningOut = trackSettlement(
            fanOut(["failing", "slow"] as const, (item) => invocations[item]())
        );
        await waitForTicks();

        expect(fanningOut.isSettled).toBe(false);

        slowItemGate.resolve();

        await expect(fanningOut.promise).rejects.toThrowError("fast failure");
        expect(isSlowItemFinished).toBe(true);
    });

    test("rejects with the first observed failure, even when a later item fails first", async () => {
        const earlierItemGate = createDeferred();
        const invocations = {
            earlier: async () => {
                await earlierItemGate.promise;
                throw new Error("earlier item, observed second");
            },
            later: async () => {
                throw new Error("later item, observed first");
            },
        };

        const fanningOut = trackSettlement(
            fanOut(["earlier", "later"] as const, (item) => invocations[item]())
        );
        await waitForTicks();
        earlierItemGate.resolve();

        await expect(fanningOut.promise).rejects.toThrowError(
            "later item, observed first"
        );
    });

    test("stops invoking later items after a synchronous throw, but waits for the started ones", async () => {
        const startedItemGate = createDeferred();
        let isStartedItemFinished = false;
        const laterItem = vi.fn();
        const invocations = {
            started: async () => {
                await startedItemGate.promise;
                isStartedItemFinished = true;
            },
            throwing: () => {
                throw new Error("synchronous failure");
            },
            later: laterItem,
        };

        const fanningOut = trackSettlement(
            fanOut(["started", "throwing", "later"] as const, (item) =>
                invocations[item]()
            )
        );
        await waitForTicks();

        expect(fanningOut.isSettled).toBe(false);
        expect(laterItem).not.toBeCalled();

        startedItemGate.resolve();

        await expect(fanningOut.promise).rejects.toThrowError(
            "synchronous failure"
        );
        expect(isStartedItemFinished).toBe(true);
    });

    test("treats a rejection with undefined as a failure", async () => {
        await expect(
            fanOut([undefined], () => Promise.reject(undefined))
        ).rejects.toBeUndefined();
    });
});
