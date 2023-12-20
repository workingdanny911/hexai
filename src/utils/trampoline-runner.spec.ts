import { beforeEach, describe, expect, test, vi } from "vitest";
import { TrampolineRunner } from "./trampoline-runner";

describe("TrampolineRunner", () => {
    const execBodySpy = vi.spyOn(TrampolineRunner.prototype as any, "execBody");
    const trampolineRunner = new TrampolineRunner(0);

    beforeEach(() => {
        execBodySpy.mockClear();
        trampolineRunner.removeAllListeners();
        trampolineRunner.reset();
    });

    test("running", async () => {
        await trampolineRunner.run(1);

        expect(execBodySpy).toBeCalledTimes(1);
    });

    test("suppresses errors and emits them instead", async () => {
        const originalExecBody = (trampolineRunner as any).execBody;
        const failingExecBody = async () => {
            throw new Error("expected error");
        };
        trampolineRunner.setExecutionBody(failingExecBody);
        const errorPromise = new Promise<any>((resolve) => {
            trampolineRunner.on("error", (error) => {
                resolve(error);
            });
        });

        await trampolineRunner.run(1);
        const error = await errorPromise;
        expect(error.message).toBe("expected error");

        trampolineRunner.setExecutionBody(originalExecBody);
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

        expect(execBodySpy).toBeCalledTimes(3);
    });

    test("interval between runs", async () => {
        vi.useFakeTimers();
        const trampolineRunner = new TrampolineRunner(10);

        trampolineRunner.run(5);

        for (let i = 1; i <= 5; i++) {
            expect(execBodySpy).toBeCalledTimes(i);
            // make sure all ticks are processed
            for (let j = 0; j < 10; j++) {
                await Promise.resolve();
            }
            vi.advanceTimersByTime(10);
            // make sure all ticks are processed
            for (let j = 0; j < 10; j++) {
                await Promise.resolve();
            }
        }

        await trampolineRunner.stop();
        vi.useRealTimers();
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

        expect(execBodySpy).toBeCalledTimes(2);
    });

    test("reset", async () => {
        await trampolineRunner.run(1);

        expect(execBodySpy).toBeCalledTimes(1);
        execBodySpy.mockClear();
        await trampolineRunner.run(1);
        expect(execBodySpy).not.toBeCalled();

        trampolineRunner.reset();

        await trampolineRunner.run(1);

        expect(execBodySpy).toBeCalledTimes(1);
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

        expect(execBodySpy).not.toBeCalled();
        expect(otherExecBodySpy).toBeCalledTimes(1);
        expect(otherExecBodySpy).toBeCalledWith(trampolineRunner);
    });
});
