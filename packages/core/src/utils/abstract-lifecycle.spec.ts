import { beforeEach, describe, expect, test, vi } from "vitest";

import { AbstractLifecycle } from "./abstract-lifecycle";

class LifeCycleForTest extends AbstractLifecycle {
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

describe("AbstractLifecycle", () => {
    let lifecycle: LifeCycleForTest;

    beforeEach(() => {
        lifecycle = new LifeCycleForTest();
    });

    test("start", async () => {
        await lifecycle.start();

        expect(lifecycle.isRunning()).toBe(true);
    });

    test("starting more than once, throws error", async () => {
        await lifecycle.start();

        await expect(lifecycle.start()).rejects.toThrow("already started");
    });

    test("on start, executes onStart()", async () => {
        const onStart = vi.fn();
        lifecycle.setOnStart(onStart);

        await lifecycle.start();

        expect(onStart).toHaveBeenCalled();
    });

    test("stop", async () => {
        await lifecycle.start();

        await lifecycle.stop();

        expect(lifecycle.isRunning()).toBe(false);
    });

    test("stopping before start, throws error", async () => {
        await expect(lifecycle.stop()).rejects.toThrow("not started");
    });

    test("on stop, executes onStop()", async () => {
        const onStop = vi.fn();
        lifecycle.setOnStop(onStop);
        await lifecycle.start();

        await lifecycle.stop();

        expect(onStop).toHaveBeenCalled();
    });
});
