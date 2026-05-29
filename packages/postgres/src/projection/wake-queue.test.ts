import { describe, it, expect, vi } from "vitest";

import { ProjectionWakeQueue } from "./wake-queue.js";
import { createFakeLogger } from "./test-helpers.fixtures.js";

function flushMicrotasks(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ProjectionWakeQueue", () => {
    it("does not poll without wake", async () => {
        const pollFn = vi.fn().mockResolvedValue(undefined);
        new ProjectionWakeQueue(pollFn, createFakeLogger());

        await flushMicrotasks();

        expect(pollFn).not.toHaveBeenCalled();
    });

    it("coalesces multiple rapid wake calls into fewer polls", async () => {
        let pollCount = 0;
        const pollFn = vi.fn(async () => {
            pollCount++;
        });
        const queue = new ProjectionWakeQueue(pollFn, createFakeLogger());

        queue.wake();
        queue.wake();
        queue.wake();

        await flushMicrotasks();

        expect(pollCount).toBeLessThanOrEqual(2);
        expect(pollCount).toBeGreaterThanOrEqual(1);
    });

    it("prevents re-entry while draining", async () => {
        let concurrentCalls = 0;
        let maxConcurrent = 0;

        const pollFn = vi.fn(async () => {
            concurrentCalls++;
            maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
            await new Promise((resolve) => setTimeout(resolve, 10));
            concurrentCalls--;
        });

        const queue = new ProjectionWakeQueue(pollFn, createFakeLogger());

        queue.wake();
        await flushMicrotasks();
        queue.wake();
        await flushMicrotasks();

        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(maxConcurrent).toBe(1);
    });

    it("recovers from poll errors and continues on next wake", async () => {
        let callCount = 0;
        const pollFn = vi.fn(async () => {
            callCount++;
            if (callCount === 1) {
                throw new Error("poll failed");
            }
        });

        const logger = createFakeLogger();
        const queue = new ProjectionWakeQueue(pollFn, logger);

        queue.wake();
        await flushMicrotasks();
        await new Promise((resolve) => setTimeout(resolve, 10));

        queue.wake();
        await flushMicrotasks();
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(callCount).toBe(2);
        expect(logger.pollError).toHaveBeenCalledWith(expect.any(Error));
    });
});
