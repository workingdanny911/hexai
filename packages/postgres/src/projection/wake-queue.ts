import type { ProjectionEngineLogger } from "./types.js";

export class ProjectionWakeQueue {
    private pending = false;
    private draining = false;

    constructor(
        private readonly pollFn: () => Promise<void>,
        private readonly logger: ProjectionEngineLogger
    ) {}

    wake(): void {
        this.pending = true;
        this.scheduleDrain();
    }

    private scheduleDrain(): void {
        if (this.draining) return;
        this.draining = true;
        queueMicrotask(() => this.drain());
    }

    private async drain(): Promise<void> {
        try {
            while (this.pending) {
                this.pending = false;
                await this.pollFn();
            }
        } catch (error) {
            this.logger.pollError(error);
        } finally {
            this.draining = false;
            if (this.pending) {
                this.scheduleDrain();
            }
        }
    }
}
