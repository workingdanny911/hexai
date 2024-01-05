import { beforeEach, describe, expect, test, vi } from "vitest";

import { AbstractLifecycle } from "./abstract-lifecycle";

class LifecucleStub extends AbstractLifecycle {
    private _onStart?: () => Promise<void>;
    private _onStop?: () => Promise<void>;

    public setOnStart(onStart: () => Promise<void>): void {
        this._onStart = onStart;
    }

    public setOnStop(onStop: () => Promise<void>): void {
        this._onStop = onStop;
    }

    protected override async onStart(): Promise<void> {
        await this._onStart?.();
    }

    protected override async onStop(): Promise<void> {
        await this._onStop?.();
    }
}

describe("lifecycle", () => {
    let lifecycle: LifecucleStub;

    beforeEach(() => {
        lifecycle = new LifecucleStub();
    });

    test("start", async () => {
        await lifecycle.start();

        expect(lifecycle.isRunning()).toBe(true);
    });

    test("start twice", async () => {
        await lifecycle.start();

        await expect(lifecycle.start()).rejects.toThrow("already started");
    });

    test("on start", async () => {
        const onStart = vi.fn().mockImplementation(async () => {
            expect(lifecycle.isRunning()).toBe(true);
        });
        lifecycle.setOnStart(onStart);

        await lifecycle.start();

        expect(onStart).toHaveBeenCalled();
    });

    test("stop before start", async () => {
        await expect(lifecycle.stop()).rejects.toThrow("not started");
    });

    test("stop", async () => {
        await lifecycle.start();

        await lifecycle.stop();

        expect(lifecycle.isRunning()).toBe(false);
    });

    test("on stop", async () => {
        const onStop = vi.fn().mockImplementation(async () => {
            expect(lifecycle.isRunning()).toBe(false);
        });
        lifecycle.setOnStop(onStop);

        await lifecycle.start();
        await lifecycle.stop();

        expect(onStop).toHaveBeenCalled();
    });
});
