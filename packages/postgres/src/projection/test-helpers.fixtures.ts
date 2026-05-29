import { vi } from "vitest";

import { Message } from "@hexaijs/core";

import type { ProjectionEngineLogger } from "./types.js";
import type { StoredEvent } from "@hexaijs/core";
import type { PostgresUnitOfWork } from "../postgres-unit-of-work.js";

export function createFakeLogger(): ProjectionEngineLogger {
    return {
        pollError: vi.fn(),
        runnerIsolated: vi.fn(),
        runnerRetrying: vi.fn(),
        rebuildStarted: vi.fn(),
        rebuildProgress: vi.fn(),
        rebuildComplete: vi.fn(),
        rebuildError: vi.fn(),
        coordinatorStarted: vi.fn(),
        coordinatorComplete: vi.fn(),
        rebuildRetrying: vi.fn(),
        singleFallbackStarted: vi.fn(),
    };
}

export function createFakeUnitOfWork(): PostgresUnitOfWork {
    const fakeClient = { query: vi.fn(async () => ({ rows: [] })) };
    return {
        scope: vi.fn(async (fn: () => Promise<any>) => fn()),
        withClient: vi.fn(async (fn: (client: any) => Promise<any>) =>
            fn(fakeClient)
        ),
    } as unknown as PostgresUnitOfWork;
}

export function createStoredEvent(
    position: number,
    type = "test.event"
): StoredEvent {
    return {
        position,
        event: new Message({}, { headers: { type } }),
    };
}

export function createStoredEvents(count: number): StoredEvent[] {
    return Array.from({ length: count }, (_, i) => ({
        position: i + 1,
        event: new Message({}, { headers: { type: `test.event.${i + 1}` } }),
    }));
}
