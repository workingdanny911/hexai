import { describe, test, expect, beforeEach, afterEach } from "vitest";

import { waitForMs, waitForTicks } from "./wait";
import { IntervalBasedExecutor } from "./executor";

describe("IntervalBasedExecutor", () => {
    let executor: IntervalBasedExecutor;
    let executed = 0;

    beforeEach(() => {
        executed = 0;

        executor = new IntervalBasedExecutor(100);
        executor.setTarget(() => {
            executed++;
        });
    });

    afterEach(() => {
        if (executor.isRunning()) {
            executor.stop();
        }
    });

    test("cannot start without target", async () => {
        await expect(
            new IntervalBasedExecutor(0).start()
        ).rejects.toThrowError();
    });

    test("executing target once", async () => {
        await executor.start();
        await waitForTicks(1);

        expect(executed).toBe(1);
    });

    test("executing target multiple times", async () => {
        await executor.start();
        await waitForMs(100);

        expect(executed).toBeGreaterThanOrEqual(2);
    });

    test("time is waited between executions", async () => {
        executor.setTarget(async () => {
            await waitForMs(100);
            executed++;
        });

        await executor.start();
        // 100ms(first execution) + 100ms(second execution) + 100ms(third execution) + 10ms(overhead)
        await waitForMs(100 + 100 + 100 + 10);

        expect(executed).toBe(2);
    });

    test("stopping executor", async () => {
        await executor.start();

        await waitForMs(100);
        expect(executed).toBeGreaterThanOrEqual(2);

        await executor.stop();

        const executedBefore = executed;
        await waitForMs(100);
        expect(executed).toBe(executedBefore);
    });
});
