/* eslint @typescript-eslint/no-unused-vars: 0 */
import { beforeEach, describe, expect, it, test, vi } from "vitest";
import { waitForTicks } from "@hexai/core/test";

import { Pipe } from "./pipe";

describe("pipe", () => {
    let increment: Pipe<number, number>;
    let double: Pipe<number, number>;
    let dummy: Pipe<void, null>;

    beforeEach(() => {
        increment = Pipe.from((payload, { next }) => next(payload + 1));
        double = Pipe.from((payload, { next }) => next(payload * 2));
        dummy = Pipe.from((payload, { next }) => next(null));
    });

    test.each([undefined, null, 1, "a", {}, []])(
        "pipe can only be created from a function",
        (notAPipeLike) => {
            // @ts-expect-error
            expect(() => Pipe.from(notAPipeLike)).toThrowError(
                /.*is not a function.*/
            );
        }
    );

    test("extending", async () => {
        let result!: number;
        const increamentAndDouble = increment.extend(double).extend((input) => {
            result = input;
        });

        await increamentAndDouble.send(0);

        expect(result).toBe(2);
    });

    it("notifies subscribers", async () => {
        const result = await new Promise((resolve) => {
            increment.send(0);
            increment.subscribe((result) => resolve(result));
        });

        expect(result).toBe(1);
    });

    test("multiple subscribers", async () => {
        const subscriber1 = vi.fn();
        const subscriber2 = vi.fn();

        increment.subscribe(subscriber1);
        increment.subscribe(subscriber2);

        await increment.send(0);
        expect(subscriber1).toHaveBeenCalledTimes(1);
        expect(subscriber2).toHaveBeenCalledTimes(1);
    });

    test("extending does not affect the original pipe", async () => {
        const incrementResults: number[] = [];
        increment.subscribe((result) => {
            incrementResults.push(result);
        });

        await increment.extend(double).send(0);

        expect(incrementResults).toHaveLength(0);
    });

    test("cloning", async () => {
        const cloned = increment.clone();

        expect(cloned).not.toBe(increment);
        const result = await new Promise((resolve) => {
            cloned.subscribe(resolve);
            cloned.send(0);
        });
        expect(result).toBe(1);
    });

    it("each send creates context", async () => {
        let timeTaken!: number;

        const measuringPipe = Pipe.from(async (payload, { next }) => {
            const start = Date.now();
            await next(payload);
            timeTaken = Date.now() - start;
        });
        const timeTakingPipe = Pipe.from(async (payload) => {
            await new Promise((resolve) => {
                setTimeout(() => {
                    resolve(undefined);
                }, 100);
            });
        });

        await measuringPipe.extend(timeTakingPipe).send(null);

        expect(timeTaken).toBeGreaterThanOrEqual(100);
    });

    it("does not wait for subscribers to complete execution", async () => {
        let isSubscriberExecutionCompleted = false;
        dummy.subscribe(async () => {
            await waitForTicks();

            isSubscriberExecutionCompleted = true;
        });

        await dummy.send();

        expect(isSubscriberExecutionCompleted).toBe(false);
    });

    test.each([1, "string", null, undefined, {}, []])(
        "pass-through pipe",
        async (payload) => {
            let result!: unknown;
            const pipe = Pipe.passThrough().extend((payload) => {
                result = payload;
            });

            await pipe.send(payload);
            expect(result).toBe(payload);
        }
    );
});
