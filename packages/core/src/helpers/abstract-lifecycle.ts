import { Lifecycle } from "./lifecycle";

export abstract class AbstractLifecycle implements Lifecycle {
    private _isRunning = false;

    public async start(): Promise<void> {
        this.assertIsNotRunning();
        this._isRunning = true;

        await this.onStart();
    }

    protected assertIsNotRunning(): asserts this is { isRunning(): false } {
        if (this.isRunning()) {
            throw new Error("already started");
        }
    }

    protected async onStart(): Promise<void> {
        return;
    }

    public async stop(): Promise<void> {
        this.assertIsRunning();

        this._isRunning = false;
        await this.onStop();
    }

    protected assertIsRunning(): asserts this is { isRunning(): true } {
        if (!this.isRunning()) {
            throw new Error("not started");
        }
    }

    protected async onStop(): Promise<void> {
        return;
    }

    public isRunning(): boolean {
        return this._isRunning;
    }
}
