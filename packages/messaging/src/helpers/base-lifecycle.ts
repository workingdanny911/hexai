import { Lifecycle } from "@/lifecycle";

export class BaseLifecycle implements Lifecycle {
    private _isRunning = false;

    public async start(): Promise<void> {
        this._isRunning = true;
    }

    public async stop(): Promise<void> {
        this.assertIsRunning();

        this._isRunning = false;
    }

    public isRunning(): boolean {
        return this._isRunning;
    }

    protected assertIsRunning(): asserts this is { isRunning(): true } {
        if (!this.isRunning()) {
            throw new Error("not started");
        }
    }
}
