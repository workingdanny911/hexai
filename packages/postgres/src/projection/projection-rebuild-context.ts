import { Propagation } from "@hexaijs/core";
import type { StoredEvent } from "@hexaijs/core";

import { CheckpointStore } from "./checkpoint-store.js";

import type { PostgresUnitOfWork } from "../postgres-unit-of-work.js";
import type { IPostgresReadModel } from "./read-model.js";
import type { ProjectionEngineLogger } from "./types.js";

type ContextState = "active" | "completed" | "isolated";

export interface RebuildContextConfig {
    batchSize: number;
    maxRetries: number;
    targetPosition: number;
    totalEvents: number;
    startPosition: number;
}

export class ProjectionRebuildContext {
    private batch: StoredEvent[] = [];
    private processed: number;
    private state: ContextState = "active";
    private position: number;
    private lastAcceptedPosition: number;

    constructor(
        private readonly readModel: IPostgresReadModel,
        private readonly checkpointStore: CheckpointStore,
        private readonly unitOfWork: PostgresUnitOfWork,
        private readonly logger: ProjectionEngineLogger,
        private readonly config: RebuildContextConfig
    ) {
        this.position = config.startPosition;
        this.lastAcceptedPosition = config.startPosition;
        this.processed = 0;
    }

    get name(): string {
        return this.readModel.name;
    }

    get isActive(): boolean {
        return this.state === "active";
    }

    get isCompleted(): boolean {
        return this.state === "completed";
    }

    get isIsolated(): boolean {
        return this.state === "isolated";
    }

    get currentPosition(): number {
        return this.position;
    }

    getProgress(): { processed: number; total: number } {
        return { processed: this.processed, total: this.config.totalEvents };
    }

    accept(event: StoredEvent): (() => Promise<void>) | undefined {
        if (this.state !== "active") return undefined;
        if (event.position <= this.lastAcceptedPosition) return undefined;

        if (event.position > this.config.targetPosition) {
            this.state = "completed";
            this.logger.rebuildComplete(this.name, this.processed);
            return undefined;
        }

        this.batch.push(event);
        this.lastAcceptedPosition = event.position;

        if (this.batch.length >= this.config.batchSize) {
            const captured = this.batch;
            this.batch = [];
            return () => this.flushBatch(captured);
        }

        return undefined;
    }

    async flushRemaining(): Promise<void> {
        if (this.batch.length === 0 || this.state !== "active") return;

        const captured = this.batch;
        this.batch = [];
        await this.flushBatch(captured);
    }

    private async flushBatch(batch: StoredEvent[]): Promise<void> {
        if (await this.tryBatchFlush(batch)) return;

        const lastError = await this.trySingleFallback(batch);
        if (!lastError) return;

        await this.isolate(lastError);
    }

    private async tryBatchFlush(batch: StoredEvent[]): Promise<boolean> {
        const lastEvent = batch[batch.length - 1];

        for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
            try {
                await this.unitOfWork.scope(async () => {
                    await this.unitOfWork.withClient(async (client) => {
                        for (const storedEvent of batch) {
                            if (this.readModel.canHandle(storedEvent)) {
                                await this.readModel.apply(
                                    storedEvent,
                                    client
                                );
                            }
                        }
                        await this.checkpointStore.save(
                            this.readModel.name,
                            lastEvent.position,
                            this.readModel.version,
                            client,
                            "rebuilding"
                        );
                    });
                }, { propagation: Propagation.NEW });

                this.position = lastEvent.position;
                this.processed += batch.length;
                this.reportProgress();
                this.checkCompletion(lastEvent);
                return true;
            } catch (error) {
                this.logger.rebuildRetrying(
                    this.name,
                    attempt,
                    this.config.maxRetries,
                    error
                );
            }
        }

        return false;
    }

    private async trySingleFallback(
        batch: StoredEvent[]
    ): Promise<Error | null> {
        this.logger.singleFallbackStarted(this.name, batch.length);

        for (const storedEvent of batch) {
            if (storedEvent.position <= this.position) continue;

            const error = await this.trySingleEvent(storedEvent);
            if (error) return error;
        }

        return null;
    }

    private async trySingleEvent(
        storedEvent: StoredEvent
    ): Promise<Error | null> {
        let lastError: unknown;

        for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
            try {
                await this.unitOfWork.scope(async () => {
                    await this.unitOfWork.withClient(async (client) => {
                        if (this.readModel.canHandle(storedEvent)) {
                            await this.readModel.apply(storedEvent, client);
                        }
                        await this.checkpointStore.save(
                            this.readModel.name,
                            storedEvent.position,
                            this.readModel.version,
                            client,
                            "rebuilding"
                        );
                    });
                }, { propagation: Propagation.NEW });

                this.position = storedEvent.position;
                this.processed++;
                this.reportProgress();
                this.checkCompletion(storedEvent);
                return null;
            } catch (error) {
                lastError = error;
                this.logger.rebuildRetrying(
                    this.name,
                    attempt,
                    this.config.maxRetries,
                    error
                );
            }
        }

        return lastError instanceof Error
            ? lastError
            : new Error(String(lastError));
    }

    private async isolate(error: Error): Promise<void> {
        this.state = "isolated";

        try {
            await this.unitOfWork.scope(async () => {
                await this.unitOfWork.withClient(async (client) => {
                    await this.checkpointStore.updateStatus(
                        this.name,
                        "isolated",
                        client
                    );
                });
            }, { propagation: Propagation.NEW });
        } catch (persistError) {
            // Best-effort: in-memory isolated status is retained, but surface the
            // failure so durable isolation gaps are visible.
            this.logger.pollError(persistError);
        }

        this.logger.runnerIsolated(this.name, this.config.maxRetries, error);
    }

    private reportProgress(): void {
        this.logger.rebuildProgress(
            this.name,
            this.processed,
            this.config.totalEvents,
            this.position
        );
    }

    private checkCompletion(lastEvent: StoredEvent): void {
        if (lastEvent.position >= this.config.targetPosition) {
            this.state = "completed";
            this.logger.rebuildComplete(this.name, this.processed);
        }
    }
}
