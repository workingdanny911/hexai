import type { StoredEvent } from "@hexaijs/core";

export type ProjectionMode = "running" | "rebuilding";
export type ProjectionHealth = "healthy" | "retrying" | "isolated";
export type CheckpointStatus = "running" | "rebuilding" | "isolated";

export interface ProjectionEngineLogger {
    pollError(error: unknown): void;
    runnerIsolated(
        projectionName: string,
        maxRetries: number,
        error: unknown
    ): void;
    runnerRetrying(
        projectionName: string,
        retryCount: number,
        maxRetries: number,
        error: unknown
    ): void;
    rebuildStarted(projectionName: string, totalEvents: number): void;
    rebuildProgress(
        projectionName: string,
        processed: number,
        total: number,
        position: number
    ): void;
    rebuildComplete(projectionName: string, processed: number): void;
    rebuildError(
        projectionName: string,
        position: number,
        error: unknown
    ): void;
    coordinatorStarted(
        projectionCount: number,
        startPosition: number,
        targetPosition: number
    ): void;
    coordinatorComplete(projectionCount: number): void;
    rebuildRetrying(
        projectionName: string,
        attempt: number,
        maxRetries: number,
        error: unknown
    ): void;
    singleFallbackStarted(projectionName: string, batchSize: number): void;
}

export interface Checkpoint {
    projectionName: string;
    lastPosition: number;
    version: number;
    status: CheckpointStatus;
    updatedAt: Date;
}

export interface ProjectionStatus {
    name: string;
    version: number;
    mode: ProjectionMode;
    health: ProjectionHealth;
    lastPosition: number;
    retryCount: number;
    rebuildProgress?: { processed: number; total: number };
}

export interface ReadableEventStore {
    stream(
        afterPosition: number,
        batchSize: number
    ): AsyncGenerator<StoredEvent>;
    getLastPosition(): Promise<number>;
    getEventCount(afterPosition: number): Promise<number>;
}

export interface ProjectionEngineOptions {
    streamBatchSize?: number;
    maxRetries?: number;
    safetyIntervalMs?: number;
    rebuildBatchSize?: number;
    rebuildFlushConcurrency?: number;
}
