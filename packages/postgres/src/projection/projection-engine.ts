import { CheckpointStore } from "./checkpoint-store.js";
import { ProjectionRebuildContext } from "./projection-rebuild-context.js";
import { ProjectionRunner } from "./projection-runner.js";
import { StartupRebuildCoordinator } from "./startup-rebuild-coordinator.js";
import { ProjectionWakeQueue } from "./wake-queue.js";

import type { PostgresUnitOfWork } from "../postgres-unit-of-work.js";
import type { IPostgresReadModel } from "./read-model.js";
import type {
    ProjectionEngineLogger,
    ProjectionEngineOptions,
    ProjectionStatus,
    ReadableEventStore,
} from "./types.js";

const DEFAULT_STREAM_BATCH_SIZE = 100;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_SAFETY_INTERVAL_MS = 1000;
const DEFAULT_REBUILD_BATCH_SIZE = 100;
const DEFAULT_REBUILD_FLUSH_CONCURRENCY = 3;

export class ProjectionEngine {
    private readonly runners: Map<string, ProjectionRunner> = new Map();
    private readonly checkpointStore = new CheckpointStore();
    private readonly streamBatchSize: number;
    private readonly maxRetries: number;
    private readonly safetyIntervalMs: number;
    private readonly rebuildBatchSize: number;
    private readonly rebuildFlushConcurrency: number;
    private rebuildAbortController: AbortController | null = null;
    private rebuildPromise: Promise<void> | null = null;
    private resetPromise: Promise<void> | null = null;
    private activePollPromise: Promise<void> | null = null;
    private safetyTimer: ReturnType<typeof setInterval> | null = null;
    private started = false;
    private polling = false;
    private resetting = false;

    constructor(
        private readonly eventStore: ReadableEventStore,
        private readonly unitOfWork: PostgresUnitOfWork,
        private readonly logger: ProjectionEngineLogger,
        options: ProjectionEngineOptions = {}
    ) {
        this.streamBatchSize =
            options.streamBatchSize ?? DEFAULT_STREAM_BATCH_SIZE;
        this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
        this.safetyIntervalMs =
            options.safetyIntervalMs ?? DEFAULT_SAFETY_INTERVAL_MS;
        this.rebuildBatchSize =
            options.rebuildBatchSize ?? DEFAULT_REBUILD_BATCH_SIZE;
        this.rebuildFlushConcurrency =
            options.rebuildFlushConcurrency ??
            DEFAULT_REBUILD_FLUSH_CONCURRENCY;
        this.validateOptions();
    }

    register(readModel: IPostgresReadModel): void {
        if (this.started) {
            throw new Error(
                "Cannot register read models after engine has started"
            );
        }
        if (this.runners.has(readModel.name)) {
            throw new Error(
                `Projection "${readModel.name}" is already registered`
            );
        }
        const runner = new ProjectionRunner(
            readModel,
            this.checkpointStore,
            this.unitOfWork,
            this.logger,
            this.maxRetries
        );
        this.runners.set(readModel.name, runner);
    }

    createWakeQueue(): ProjectionWakeQueue {
        return new ProjectionWakeQueue(() => this.poll(), this.logger);
    }

    async start(): Promise<void> {
        if (this.started) {
            throw new Error("Projection engine has already started");
        }

        for (const runner of this.runners.values()) {
            await runner.initialize();
        }

        this.started = true;
        this.safetyTimer = setInterval(() => {
            this.poll().catch((err) => this.logger.pollError(err));
        }, this.safetyIntervalMs);

        const rebuildRunners = [...this.runners.values()].filter(
            (runner) => runner.isRebuilding
        );
        if (rebuildRunners.length > 0) {
            this.rebuildAbortController = new AbortController();
            const signal = this.rebuildAbortController.signal;
            this.rebuildPromise = this.runStartupRebuild(rebuildRunners, signal)
                .catch((err) => {
                    this.logger.pollError(err);
                    // A failed startup rebuild would otherwise leave runners stuck
                    // in "rebuilding" and silently excluded from polling. Surface
                    // them as isolated so status is observable and resetProjection
                    // can recover; a restart re-attempts the rebuild.
                    if (!signal.aborted) {
                        for (const runner of rebuildRunners) {
                            if (runner.isRebuilding) {
                                runner.markIsolatedFromRebuild();
                            }
                        }
                    }
                })
                .finally(() => {
                    if (this.rebuildAbortController?.signal === signal) {
                        this.rebuildAbortController = null;
                    }
                    this.rebuildPromise = null;
                });
        }
    }

    async stop(): Promise<void> {
        this.rebuildAbortController?.abort();

        if (this.safetyTimer) {
            clearInterval(this.safetyTimer);
            this.safetyTimer = null;
        }

        await this.activePollPromise;
        // Await any in-flight reset (including its resetForFreshRebuild phase) so
        // stop() never returns while a reset is still writing to the database.
        await this.resetPromise;
        await this.rebuildPromise;

        this.rebuildAbortController = null;
        this.started = false;
    }

    async poll(): Promise<void> {
        if (this.resetting || this.polling || this.runners.size === 0) return;

        this.activePollPromise = this.executePoll();
        try {
            await this.activePollPromise;
        } finally {
            this.activePollPromise = null;
        }
    }

    private async executePoll(): Promise<void> {
        this.polling = true;

        try {
            const activeRunners = [...this.runners.values()].filter(
                (runner) => runner.isActive
            );
            if (activeRunners.length === 0) return;

            const blockedRunners = new Set<string>();
            const minPosition = this.getMinPosition(activeRunners);
            for await (const storedEvent of this.eventStore.stream(
                minPosition,
                this.streamBatchSize
            )) {
                for (const runner of activeRunners) {
                    if (blockedRunners.has(runner.name)) continue;
                    if (storedEvent.position <= runner.currentPosition)
                        continue;
                    const result = await runner.processEvent(storedEvent);
                    if (result === "retrying" || result === "isolated") {
                        blockedRunners.add(runner.name);
                    }
                }
            }
        } finally {
            this.polling = false;
        }
    }

    async resetProjection(name: string): Promise<void> {
        const runner = this.runners.get(name);
        if (!runner) {
            throw new Error(`Projection "${name}" not found`);
        }

        // Serialize resets so concurrent calls don't race on rebuild state, and
        // expose the whole operation via resetPromise so stop() can await it
        // (including the resetForFreshRebuild phase before the rebuild starts).
        while (this.resetPromise) {
            await this.resetPromise.catch(() => {});
        }

        this.resetting = true;
        const reset = this.doResetProjection(runner);
        this.resetPromise = reset.catch(() => {});
        try {
            await reset;
        } finally {
            this.resetPromise = null;
            this.resetting = false;
        }
    }

    private async doResetProjection(runner: ProjectionRunner): Promise<void> {
        await this.activePollPromise;
        this.rebuildAbortController?.abort();
        await this.rebuildPromise;
        await runner.resetForFreshRebuild();

        this.rebuildAbortController = new AbortController();
        const signal = this.rebuildAbortController.signal;
        this.rebuildPromise = this.runStartupRebuild([runner], signal);
        try {
            await this.rebuildPromise;
        } finally {
            if (this.rebuildAbortController?.signal === signal) {
                this.rebuildAbortController = null;
            }
            this.rebuildPromise = null;
        }
    }

    getStatus(): ProjectionStatus[] {
        return [...this.runners.values()].map((runner) => runner.getStatus());
    }

    private async runStartupRebuild(
        rebuildRunners: ProjectionRunner[],
        signal?: AbortSignal
    ): Promise<void> {
        if (rebuildRunners.length === 0) return;

        const targetPosition = await this.eventStore.getLastPosition();
        const runnersToRebuild: ProjectionRunner[] = [];

        for (const runner of rebuildRunners) {
            if (runner.currentPosition >= targetPosition) {
                await runner.activateAfterRebuild(targetPosition);
            } else {
                runnersToRebuild.push(runner);
            }
        }

        if (runnersToRebuild.length === 0) return;

        const startPosition = Math.min(
            ...runnersToRebuild.map((runner) => runner.currentPosition)
        );

        if (targetPosition === 0) {
            for (const runner of runnersToRebuild) {
                await runner.activateAfterRebuild(0);
            }
            return;
        }

        const eventCount = await this.eventStore.getEventCount(0);

        const contexts = runnersToRebuild.map((runner) => {
            this.logger.rebuildStarted(runner.name, eventCount);
            return new ProjectionRebuildContext(
                runner.projectionReadModel,
                this.checkpointStore,
                this.unitOfWork,
                this.logger,
                {
                    batchSize: this.rebuildBatchSize,
                    maxRetries: this.maxRetries,
                    targetPosition,
                    totalEvents: eventCount,
                    startPosition: runner.currentPosition,
                }
            );
        });

        const coordinator = new StartupRebuildCoordinator(
            contexts,
            startPosition,
            targetPosition,
            this.eventStore,
            this.logger,
            this.streamBatchSize,
            this.rebuildFlushConcurrency,
            signal
        );

        const result = await coordinator.run();
        if (signal?.aborted) return;

        for (const name of result.completed) {
            const ctx = contexts.find((context) => context.name === name)!;
            await this.runners
                .get(name)
                ?.activateAfterRebuild(ctx.currentPosition);
        }
        for (const name of result.isolated) {
            this.runners.get(name)?.markIsolatedFromRebuild();
        }

        const settled = new Set([...result.completed, ...result.isolated]);
        for (const ctx of contexts) {
            if (settled.has(ctx.name)) continue;
            // The stream ended before this context reached the rebuild target
            // (e.g. a non-monotonic event store). Rather than leaving the runner
            // stuck in "rebuilding" forever, surface it and hand off to live
            // polling from its current position so later polls can catch up.
            this.logger.pollError(
                new Error(
                    `Projection "${ctx.name}" rebuild ended without reaching the ` +
                        `target position; activating live polling at position ${ctx.currentPosition}`
                )
            );
            await this.runners
                .get(ctx.name)
                ?.activateAfterRebuild(ctx.currentPosition);
        }
    }

    private validateOptions(): void {
        this.assertPositiveInteger("streamBatchSize", this.streamBatchSize);
        this.assertPositiveInteger("maxRetries", this.maxRetries);
        this.assertPositiveInteger("safetyIntervalMs", this.safetyIntervalMs);
        this.assertPositiveInteger("rebuildBatchSize", this.rebuildBatchSize);
        this.assertPositiveInteger(
            "rebuildFlushConcurrency",
            this.rebuildFlushConcurrency
        );
    }

    private assertPositiveInteger(name: string, value: number): void {
        if (!Number.isInteger(value) || value < 1) {
            throw new Error(
                `Projection engine option "${name}" must be a positive integer`
            );
        }
    }

    private getMinPosition(runners: ProjectionRunner[]): number {
        let min = Infinity;
        for (const runner of runners) {
            if (runner.currentPosition < min) {
                min = runner.currentPosition;
            }
        }
        return min === Infinity ? 0 : min;
    }
}
