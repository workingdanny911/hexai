import { waitForMs } from "./wait";
import { AbstractLifecycle } from "./abstract-lifecycle";

export class Executor extends AbstractLifecycle {
    protected target: (() => void) | null = null;

    public setTarget(target: () => void): void {
        this.target = target;
    }
}

export class IntervalBasedExecutor extends Executor {
    constructor(private interval: number) {
        super();
    }

    protected async onStart(): Promise<void> {
        if (!this.target) {
            throw new Error("Target is not set");
        }

        this.loop();
    }

    private async loop(): Promise<void> {
        if (this.isRunning()) {
            await this.target!();
            await waitForMs(this.interval);
            this.loop();
        }
    }
}
