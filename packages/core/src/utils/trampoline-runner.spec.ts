import { beforeEach, describe, expect, MockedFunction, test, vi } from "vitest";

import { TrampolineRunner } from "./trampoline-runner";

describe("TrampolineRunner", () => {
    let spy: MockedFunction<any>;
    let trampolineRunner: TrampolineRunner;

    function makeTrampolineRunner(interval = 0) {
        const runner = new TrampolineRunner(interval);
        runner.setExecutionBody(spy);
        return runner;
    }

    beforeEach(() => {
        spy = vi.fn();
        trampolineRunner = makeTrampolineRunner();
    });

    test("running", async () => {
        await trampolineRunner.run(1);

        expect(spy).toBeCalledTimes(1);
    });

    test("suppresses errors and emits them instead", async () => {
        spy.mockImplementation(async () => {
            throw new Error("expected error");
        });
        const errorPromise = new Promise<any>((resolve) => {
            trampolineRunner.on("error", (error) => {
                resolve(error);
            });
        });

        await trampolineRunner.run(1);
        const error = await errorPromise;
        expect(error.message).toBe("expected error");
    });

    test("emits stopped event", async () => {
        let stopped = false;
        trampolineRunner.on("stopped", () => {
            stopped = true;
        });

        await trampolineRunner.run(1);

        expect(stopped).toBe(true);
    });

    test("running for a number of times", async () => {
        await trampolineRunner.run(3);

        expect(spy).toBeCalledTimes(3);
    });

    function wait(ms: number) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    test("interval between runs", async () => {
        const interval = 10;
        const trampolineRunner = makeTrampolineRunner(interval);
        trampolineRunner.run(5);

        for (let i = 1; i <= 5; i++) {
            expect(spy).toBeCalledTimes(i);
            // + 1 to make sure the event loop has time to run the next iteration
            await wait(interval + 1);
        }

        await trampolineRunner.stop();
    });

    test("stopping", async () => {
        let ranFor = 0;
        trampolineRunner.on("ran", async () => {
            if (++ranFor === 2) {
                await trampolineRunner.stop();
            }
        });
        const stopEventPromise = new Promise((resolve) => {
            trampolineRunner.on("stopped", resolve);
        });

        trampolineRunner.run(10000);
        await stopEventPromise;

        expect(spy).toBeCalledTimes(2);
    });

    test("reset", async () => {
        await trampolineRunner.run(1);

        expect(spy).toBeCalledTimes(1);
        await trampolineRunner.run(1);
        // did not run again
        expect(spy).toBeCalledTimes(1);

        trampolineRunner.reset();

        await trampolineRunner.run(1);
        expect(spy).toBeCalledTimes(2);
    });

    test("can run forever", async () => {
        let ranFor = 0;
        trampolineRunner.on("ran", async () => {
            if (ranFor++ > 10) {
                await trampolineRunner.stop();
            }
        });
        const stopEventPromise = new Promise((resolve) => {
            trampolineRunner.on("stopped", () => resolve(true));
        });

        await trampolineRunner.run();

        await expect(stopEventPromise).resolves.toBe(true);
    });

    test("execution body can be set or replaced", async () => {
        const otherExecBodySpy = vi.fn(async () => {
            return;
        });
        trampolineRunner.setExecutionBody(otherExecBodySpy);

        await trampolineRunner.run(1);

        expect(spy).not.toBeCalled();
        expect(otherExecBodySpy).toBeCalledTimes(1);
        expect(otherExecBodySpy).toBeCalledWith(trampolineRunner);
    });
});
