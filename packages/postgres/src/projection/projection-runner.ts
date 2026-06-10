import { Propagation } from "@hexaijs/core";
import type { StoredEvent } from "@hexaijs/core";

import { CheckpointStore } from "./checkpoint-store.js";

import type { PostgresUnitOfWork } from "../postgres-unit-of-work.js";
import type { IPostgresReadModel } from "./read-model.js";
import type {
    ProjectionEngineLogger,
    ProjectionHealth,
    ProjectionMode,
    ProjectionStatus,
} from "./types.js";

export type ProjectionProcessResult =
    | "processed"
    | "retrying"
    | "isolated"
    | "skipped";

export class ProjectionRunner {
    private mode: ProjectionMode = "running";
    private health: ProjectionHealth = "healthy";
    private retryCount = 0;
    private retryPosition: number | null = null;
    private lastPosition = 0;
    private resetting = false;

    constructor(
        private readonly readModel: IPostgresReadModel,
        private readonly checkpointStore: CheckpointStore,
        private readonly unitOfWork: PostgresUnitOfWork,
        private readonly logger: ProjectionEngineLogger,
        private readonly maxRetries: number = 3
    ) {}

    get name(): string {
        return this.readModel.name;
    }

    get version(): number {
        return this.readModel.version;
    }

    get currentPosition(): number {
        return this.lastPosition;
    }

    get isRebuilding(): boolean {
        return this.mode === "rebuilding";
    }

    get isIsolated(): boolean {
        return this.health === "isolated";
    }

    get isActive(): boolean {
        return this.mode === "running" && this.health !== "isolated";
    }

    get projectionReadModel(): IPostgresReadModel {
        return this.readModel;
    }

    getStatus(): ProjectionStatus {
        return {
            name: this.readModel.name,
            version: this.readModel.version,
            mode: this.mode,
            health: this.health,
            lastPosition: this.lastPosition,
            retryCount: this.retryCount,
        };
    }

    async initialize(): Promise<void> {
        const checkpoint = await this.unitOfWork.withClient((client) =>
            this.checkpointStore.get(this.readModel.name, client)
        );

        if (!checkpoint || checkpoint.version !== this.readModel.version) {
            await this.resetForFreshRebuild();
            return;
        }

        this.lastPosition = checkpoint.lastPosition;

        switch (checkpoint.status) {
            case "rebuilding":
                this.resumeRebuildFromCheckpoint();
                return;
            case "isolated":
                this.mode = "running";
                this.health = "isolated";
                return;
            case "running":
                this.mode = "running";
                this.health = "healthy";
                return;
            default:
                throw new Error(
                    `Projection "${this.readModel.name}" has unknown checkpoint status "${checkpoint.status}"`
                );
        }
    }

    async resetForFreshRebuild(): Promise<void> {
        if (this.resetting) return;
        this.resetting = true;
        this.mode = "rebuilding";
        this.health = "healthy";

        try {
            await this.unitOfWork.scope(async () => {
                await this.unitOfWork.withClient(async (client) => {
                    await this.readModel.reset(client);
                    await this.checkpointStore.reset(
                        this.readModel.name,
                        client
                    );
                    await this.checkpointStore.save(
                        this.readModel.name,
                        0,
                        this.readModel.version,
                        client,
                        "rebuilding"
                    );
                });
            }, { propagation: Propagation.NEW });

            this.lastPosition = 0;
            this.retryCount = 0;
        } finally {
            this.resetting = false;
        }
    }

    resumeRebuildFromCheckpoint(): void {
        this.mode = "rebuilding";
        this.health = "healthy";
    }

    async activateAfterRebuild(position: number): Promise<void> {
        await this.unitOfWork.scope(async () => {
            await this.unitOfWork.withClient(async (client) => {
                await this.checkpointStore.save(
                    this.readModel.name,
                    position,
                    this.readModel.version,
                    client,
                    "running"
                );
            });
        }, { propagation: Propagation.NEW });

        this.lastPosition = position;
        this.mode = "running";
        this.health = "healthy";
        this.retryCount = 0;
        this.retryPosition = null;
    }

    markIsolatedFromRebuild(): void {
        this.mode = "running";
        this.health = "isolated";
    }

    async processEvent(
        storedEvent: StoredEvent
    ): Promise<ProjectionProcessResult> {
        if (!this.isActive) return "skipped";

        try {
            const effectivePosition = await this.applyAndCheckpoint(
                storedEvent
            );
            this.advancePosition(effectivePosition);
            return "processed";
        } catch (error) {
            return this.handleProcessingFailure(storedEvent.position, error);
        }
    }

    // Reads the committed checkpoint under a row lock within the same
    // transaction as the mutation. When the event is already covered by the
    // committed position — the in-process retry window after a commit-ambiguous
    // failure — apply and save are skipped and the committed position is
    // returned so the in-memory position advances past the duplicate.
    private async applyAndCheckpoint(
        storedEvent: StoredEvent
    ): Promise<number> {
        return this.unitOfWork.scope(async () => {
            return this.unitOfWork.withClient(async (client) => {
                const checkpoint = await this.checkpointStore.getForUpdate(
                    this.readModel.name,
                    client
                );
                const committed = checkpoint?.lastPosition ?? 0;
                if (storedEvent.position <= committed) {
                    return committed;
                }

                if (this.readModel.canHandle(storedEvent)) {
                    await this.readModel.apply(storedEvent, client);
                }
                await this.checkpointStore.save(
                    this.readModel.name,
                    storedEvent.position,
                    this.readModel.version,
                    client
                );
                return storedEvent.position;
            });
        }, { propagation: Propagation.NEW });
    }

    private advancePosition(position: number): void {
        this.lastPosition = position;
        if (this.health === "retrying") {
            this.health = "healthy";
            this.retryCount = 0;
            this.retryPosition = null;
        }
    }

    private async handleProcessingFailure(
        position: number,
        error: unknown
    ): Promise<ProjectionProcessResult> {
        if (this.retryPosition !== position) {
            this.retryPosition = position;
            this.retryCount = 0;
        }

        this.retryCount++;
        if (this.retryCount >= this.maxRetries) {
            this.health = "isolated";
            await this.persistIsolation();
            this.logger.runnerIsolated(this.name, this.maxRetries, error);
            return "isolated";
        } else {
            this.health = "retrying";
            this.logger.runnerRetrying(
                this.name,
                this.retryCount,
                this.maxRetries,
                error
            );
            return "retrying";
        }
    }

    private async persistIsolation(): Promise<void> {
        try {
            await this.unitOfWork.scope(async () => {
                await this.unitOfWork.withClient(async (client) => {
                    // Upsert (not updateStatus) so isolation persists even when no
                    // checkpoint row exists yet — e.g. a poison first event before
                    // any successful apply has written a checkpoint.
                    await this.checkpointStore.save(
                        this.readModel.name,
                        this.lastPosition,
                        this.readModel.version,
                        client,
                        "isolated"
                    );
                });
            }, { propagation: Propagation.NEW });
        } catch (persistError) {
            // Best-effort: in-memory isolated status is retained even if DB write
            // fails, but surface the failure so durable isolation gaps are visible.
            this.logger.pollError(persistError);
        }
    }
}
