import { beforeAll, beforeEach } from "vitest";

import { Message } from "@hexaijs/core";

import { PostgresEventStore } from "../postgres-event-store.js";
import { runHexaiMigrations } from "../run-hexai-migrations.js";
import { runProjectionMigrations } from "../run-projection-migrations.js";
import {
    useClient,
    useDatabase,
    useUnitOfWork,
} from "../test-fixtures/index.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { ProjectionEngine } from "./projection-engine.js";

import type { ClientBase } from "pg";
import type { StoredEvent } from "@hexaijs/core";
import type { PostgresUnitOfWork } from "../postgres-unit-of-work.js";
import type { IPostgresReadModel } from "./read-model.js";
import type {
    Checkpoint,
    CheckpointStatus,
    ProjectionEngineLogger,
    ProjectionEngineOptions,
} from "./types.js";

const INTEGRATION_DATABASE = "test_hexai__projection_integration";
const READ_MODEL_TABLE = "projection_integration__events";
const DEFAULT_READ_MODEL_NAME = "projection-integration-read-model";

export interface ProjectionEventSpec {
    type: string;
    payload?: Record<string, unknown>;
}

export interface ProjectionRow {
    id: number;
    eventType: string;
    eventPosition: number;
    payload: Record<string, unknown>;
}

export interface ProjectionCheckpointSpec {
    name: string;
    position: number;
    version: number;
    status?: CheckpointStatus;
}

export interface ProjectionRunResult {
    rows: ProjectionRow[];
    checkpoint: Checkpoint | null;
}

export function hasProjectionIntegrationDatabaseUrl(): boolean {
    return Boolean(process.env.HEXAI_DB_URL);
}

export function useProjectionIntegrationScenario() {
    const databaseUrl = useDatabase(INTEGRATION_DATABASE);
    const client = useClient(INTEGRATION_DATABASE);
    const uow = useUnitOfWork(INTEGRATION_DATABASE);
    const eventStore = new PostgresEventStore(uow);
    const checkpointStore = new CheckpointStore();

    beforeAll(async () => {
        await migrate(databaseUrl);
    });

    beforeEach(async () => {
        await resetScenario(client);
    });

    return {
        databaseName: INTEGRATION_DATABASE,
        defaultReadModelName: DEFAULT_READ_MODEL_NAME,
        unitOfWork: uow,
        migrate: () => migrate(databaseUrl),
        reset: () => resetScenario(client),
        storeEvents: (...events: Array<string | ProjectionEventSpec>) =>
            eventStore.storeAll(events.map(createMessage)),
        runProjection: (readModel = createProjectionReadModel()) =>
            runProjection(readModel, eventStore, uow),
        projectEvents: (...events: Array<string | ProjectionEventSpec>) =>
            projectEvents(client, eventStore, uow, checkpointStore, events),
        ensureReadModelTable: () => createReadModelTable(client),
        createEngine: (
            readModel: IPostgresReadModel,
            options: ProjectionEngineOptions = {}
        ): ProjectionEngine => {
            const engine = new ProjectionEngine(
                eventStore,
                uow,
                createNoopLogger(),
                { safetyIntervalMs: 60_000, ...options }
            );
            engine.register(readModel);
            return engine;
        },
        readProjectionRows: () => readProjectionRows(client),
        readCheckpoint: (name: string = DEFAULT_READ_MODEL_NAME) =>
            checkpointStore.get(name, client),
        tablesExist: (...tableNames: string[]) =>
            tablesExist(client, tableNames),
        saveCheckpoint: (spec: ProjectionCheckpointSpec) =>
            checkpointStore.save(
                spec.name,
                spec.position,
                spec.version,
                client,
                spec.status
            ),
        markCheckpointIsolated: (name: string) =>
            checkpointStore.updateStatus(name, "isolated", client),
        resetCheckpoint: (name: string) =>
            checkpointStore.reset(name, client),
        createReadModel: createProjectionReadModel,
    };
}

async function migrate(
    databaseUrl: ReturnType<typeof useDatabase>
): Promise<void> {
    await runHexaiMigrations(databaseUrl);
    await runProjectionMigrations(databaseUrl);
}

async function resetScenario(client: ClientBase): Promise<void> {
    await client.query("TRUNCATE TABLE hexai__events RESTART IDENTITY");
    await client.query("TRUNCATE TABLE projection__checkpoints");
    await client.query(`DROP TABLE IF EXISTS ${READ_MODEL_TABLE}`);
}

async function createReadModelTable(client: ClientBase): Promise<void> {
    await client.query(`
        CREATE TABLE ${READ_MODEL_TABLE} (
            id BIGSERIAL PRIMARY KEY,
            event_type TEXT NOT NULL,
            event_position BIGINT NOT NULL,
            payload JSONB NOT NULL
        )
    `);
}

async function readProjectionRows(
    client: ClientBase
): Promise<ProjectionRow[]> {
    const result = await client.query<{
        id: string;
        event_type: string;
        event_position: string;
        payload: Record<string, unknown>;
    }>(
        `SELECT id, event_type, event_position, payload
         FROM ${READ_MODEL_TABLE}
         ORDER BY id ASC`
    );

    return result.rows.map((row) => ({
        id: Number(row.id),
        eventType: row.event_type,
        eventPosition: Number(row.event_position),
        payload: row.payload,
    }));
}

async function tablesExist(
    client: ClientBase,
    tableNames: string[]
): Promise<Record<string, boolean>> {
    const result = await client.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name = ANY($1::text[])`,
        [tableNames]
    );
    const existing = new Set(result.rows.map((row) => row.table_name));

    return Object.fromEntries(
        tableNames.map((tableName) => [tableName, existing.has(tableName)])
    );
}

function createMessage(event: string | ProjectionEventSpec): Message {
    const spec = typeof event === "string" ? { type: event } : event;
    return new Message(spec.payload ?? {}, { headers: { type: spec.type } });
}

async function projectEvents(
    client: ClientBase,
    eventStore: PostgresEventStore,
    uow: PostgresUnitOfWork,
    checkpointStore: CheckpointStore,
    events: Array<string | ProjectionEventSpec>
): Promise<ProjectionRunResult> {
    await createReadModelTable(client);
    await eventStore.storeAll(events.map(createMessage));
    await runProjection(createProjectionReadModel(), eventStore, uow);

    return {
        rows: await readProjectionRows(client),
        checkpoint: await checkpointStore.get(DEFAULT_READ_MODEL_NAME, client),
    };
}

function createProjectionReadModel(options: {
    name?: string;
    version?: number;
    handledTypes?: string[];
    failOnType?: string;
    insertBeforeFail?: boolean;
} = {}): IPostgresReadModel {
    const handledTypes = new Set(options.handledTypes ?? ["projection.handled"]);

    const insertRow = (client: ClientBase, storedEvent: StoredEvent) =>
        client.query(
            `INSERT INTO ${READ_MODEL_TABLE} (event_type, event_position, payload)
             VALUES ($1, $2, $3)`,
            [
                storedEvent.event.getMessageType(),
                storedEvent.position,
                JSON.stringify(storedEvent.event.getPayload()),
            ]
        );

    return {
        name: options.name ?? DEFAULT_READ_MODEL_NAME,
        version: options.version ?? 1,
        canHandle: (storedEvent) =>
            handledTypes.has(storedEvent.event.getMessageType()),
        apply: async (storedEvent, client) => {
            const shouldFail =
                options.failOnType === storedEvent.event.getMessageType();

            // insertBeforeFail writes a row and then throws in the same apply
            // call, proving the engine's transaction rolls the write back.
            if (shouldFail && options.insertBeforeFail) {
                await insertRow(client, storedEvent);
            }
            if (shouldFail) {
                throw new Error(
                    `projection apply failed for "${storedEvent.event.getMessageType()}"`
                );
            }

            await insertRow(client, storedEvent);
        },
        reset: async (client) => {
            await client.query(`TRUNCATE TABLE ${READ_MODEL_TABLE}`);
        },
    };
}

async function runProjection(
    readModel: IPostgresReadModel,
    eventStore: PostgresEventStore,
    uow: PostgresUnitOfWork
): Promise<void> {
    const engine = new ProjectionEngine(eventStore, uow, createNoopLogger(), {
        safetyIntervalMs: 60_000,
    });
    engine.register(readModel);

    await engine.poll();
}

function createNoopLogger(): ProjectionEngineLogger {
    return {
        pollError: noop,
        runnerIsolated: noop,
        runnerRetrying: noop,
        rebuildStarted: noop,
        rebuildProgress: noop,
        rebuildComplete: noop,
        rebuildError: noop,
        coordinatorStarted: noop,
        coordinatorComplete: noop,
        rebuildRetrying: noop,
        singleFallbackStarted: noop,
    };
}

function noop(): void {}

export type ProjectionIntegrationScenario = ReturnType<
    typeof useProjectionIntegrationScenario
>;
