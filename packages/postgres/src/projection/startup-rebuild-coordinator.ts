import type { ProjectionRebuildContext } from "./projection-rebuild-context.js";
import type { ProjectionEngineLogger, ReadableEventStore } from "./types.js";

export interface RebuildResult {
    completed: string[];
    isolated: string[];
}

export class StartupRebuildCoordinator {
    constructor(
        private readonly contexts: ProjectionRebuildContext[],
        private readonly startPosition: number,
        private readonly targetPosition: number,
        private readonly eventStore: ReadableEventStore,
        private readonly logger: ProjectionEngineLogger,
        private readonly streamBatchSize: number,
        private readonly flushConcurrency: number,
        private readonly signal?: AbortSignal
    ) {}

    async run(): Promise<RebuildResult> {
        let activeContexts = this.contexts.filter((c) => c.isActive);
        if (activeContexts.length === 0) return this.buildResult();

        this.logger.coordinatorStarted(
            activeContexts.length,
            this.startPosition,
            this.targetPosition
        );

        for await (const event of this.eventStore.stream(
            this.startPosition,
            this.streamBatchSize
        )) {
            if (this.signal?.aborted) break;
            if (event.position > this.targetPosition) break;

            const flushTasks: Array<() => Promise<void>> = [];
            for (const ctx of activeContexts) {
                const flushFn = ctx.accept(event);
                if (flushFn) flushTasks.push(flushFn);
            }

            await this.runWithConcurrencyLimit(
                flushTasks,
                this.flushConcurrency
            );

            activeContexts = activeContexts.filter((c) => c.isActive);
            if (activeContexts.length === 0) break;
        }

        if (this.signal?.aborted) {
            this.logger.coordinatorComplete(this.contexts.length);
            return this.buildResult();
        }

        const remainingFlushes = activeContexts.map(
            (c) => () => c.flushRemaining()
        );
        await this.runWithConcurrencyLimit(
            remainingFlushes,
            this.flushConcurrency
        );

        this.logger.coordinatorComplete(this.contexts.length);
        return this.buildResult();
    }

    private async runWithConcurrencyLimit(
        tasks: Array<() => Promise<void>>,
        limit: number
    ): Promise<void> {
        if (tasks.length === 0) return;
        if (!Number.isInteger(limit) || limit < 1) {
            throw new Error("Flush concurrency must be a positive integer");
        }

        let index = 0;
        const run = async (): Promise<void> => {
            while (index < tasks.length) {
                const task = tasks[index++];
                await task();
            }
        };
        const workers = Array.from(
            { length: Math.min(limit, tasks.length) },
            () => run()
        );
        await Promise.all(workers);
    }

    private buildResult(): RebuildResult {
        return {
            completed: this.contexts
                .filter((c) => c.isCompleted)
                .map((c) => c.name),
            isolated: this.contexts
                .filter((c) => c.isIsolated)
                .map((c) => c.name),
        };
    }
}
