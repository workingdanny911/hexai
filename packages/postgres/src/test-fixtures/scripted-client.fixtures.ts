import type * as pg from "pg";
import { expect, vi } from "vitest";

import { DefaultPostgresUnitOfWork } from "../postgres-unit-of-work.js";
import { IsolationLevel } from "../types.js";
import { createDeferred, type Deferred } from "./async.fixtures.js";

export class ScriptedClient {
    readonly statements: string[] = [];
    // Statements sent while another one was still in flight. pg queues
    // them internally, but that queue is deprecated.
    readonly overlappingStatements: string[] = [];
    private inFlight = 0;
    private readonly failures = new Map<string, unknown>();
    private readonly synchronousFailures = new Map<string, unknown>();
    private readonly commandTags = new Map<string, string>();
    private readonly heldResults = new Map<string, Deferred>();
    private readonly sent = new Map<string, Deferred>();
    private connectFailure?: { failure: unknown };
    private heldAcquisition?: Deferred;

    failOn(statement: string, failure: unknown): this {
        this.failures.set(statement, failure);
        return this;
    }

    failConnectWith(failure: unknown): this {
        this.connectFailure = { failure };
        return this;
    }

    // PostgreSQL answers COMMIT with the command tag ROLLBACK, without an
    // error, when the transaction had already failed.
    answerWithCommand(statement: string, command: string): this {
        this.commandTags.set(statement, command);
        return this;
    }

    // query() throws before returning a promise, as a ClientBase may.
    failSynchronouslyOn(statement: string, failure: unknown): this {
        this.synchronousFailures.set(statement, failure);
        return this;
    }

    holdResultOf(statement: string): Deferred {
        const result = createDeferred();
        this.heldResults.set(statement, result);
        return result;
    }

    whenSent(statement: string): Promise<void> {
        return this.sentSignal(statement).promise;
    }

    // Holds the unit of work's acquisition of this client until the returned
    // deferred resolves.
    holdAcquisition(): Deferred {
        this.heldAcquisition = createDeferred();
        return this.heldAcquisition;
    }

    acquire(): pg.ClientBase | Promise<pg.ClientBase> {
        const acquired = this as unknown as pg.ClientBase;
        return this.heldAcquisition
            ? this.heldAcquisition.promise.then(() => acquired)
            : acquired;
    }

    async connect(): Promise<void> {
        if (this.connectFailure) {
            throw this.connectFailure.failure;
        }
    }

    query(statement: string): Promise<pg.QueryResult> {
        this.statements.push(statement);
        if (this.inFlight > 0) {
            this.overlappingStatements.push(statement);
        }
        this.sentSignal(statement).resolve();
        if (this.synchronousFailures.has(statement)) {
            throw this.synchronousFailures.get(statement);
        }
        this.inFlight++;
        const response = this.respondTo(statement);
        const settle = () => {
            this.inFlight--;
        };
        response.then(settle, settle);
        return response;
    }

    private async respondTo(statement: string): Promise<pg.QueryResult> {
        await this.heldResults.get(statement)?.promise;
        if (this.failures.has(statement)) {
            throw this.failures.get(statement);
        }
        return {
            command: this.commandTags.get(statement) ?? statement,
            rowCount: 0,
            oid: 0,
            fields: [],
            rows: [],
        };
    }

    private sentSignal(statement: string): Deferred {
        let signal = this.sent.get(statement);
        if (!signal) {
            signal = createDeferred();
            this.sent.set(statement, signal);
        }
        return signal;
    }
}

export interface CleanUpCall {
    args: unknown[];
    statementsSentBefore: string[];
}

export const SET_SERIALIZABLE = `SET TRANSACTION ISOLATION LEVEL ${IsolationLevel.SERIALIZABLE}`;
export const SERIALIZABLE = { isolationLevel: IsolationLevel.SERIALIZABLE };

export interface CleanUpRecording {
    cleanUps: CleanUpCall[];
    cleanUpFailure(): unknown;
}

// A unit of work over one scripted client. It records each cleanup with the
// statements sent before it, and the cleanup throws whatever cleanUpFailure()
// returns at that moment.
export function createScriptedUnitOfWork(
    client: ScriptedClient,
    recording: CleanUpRecording
): DefaultPostgresUnitOfWork {
    return new DefaultPostgresUnitOfWork(
        () => client.acquire(),
        (...args: unknown[]) => {
            recording.cleanUps.push({
                args,
                statementsSentBefore: [...client.statements],
            });
            const cleanUpFailure = recording.cleanUpFailure();
            if (cleanUpFailure !== undefined) {
                throw cleanUpFailure;
            }
        }
    );
}

export function captureReportedErrors() {
    return vi.spyOn(console, "error").mockImplementation(() => {});
}

export interface ScriptedUnitOfWorkState {
    client: ScriptedClient;
    uow: DefaultPostgresUnitOfWork;
    cleanUps: CleanUpCall[];
    cleanUpFailure: unknown;
}

// The checks the scripted specs share. Each one reads the running test's
// state when it is called.
export function scriptedUnitOfWorkChecks(state: () => ScriptedUnitOfWorkState) {
    return {
        holdClientAcquisition(): Deferred {
            return state().client.holdAcquisition();
        },

        captureReportedErrors,

        expectCleanedUpOnceWithoutFailure(): void {
            const { cleanUps, client } = state();
            expect(cleanUps).toHaveLength(1);
            expect(cleanUps[0].args).toHaveLength(1);
            expect(cleanUps[0].args[0]).toBe(client);
        },

        expectCleanedUpOnceWithFailure(failure: unknown): void {
            const { cleanUps, client } = state();
            expect(cleanUps).toHaveLength(1);
            expect(cleanUps[0].args).toHaveLength(2);
            expect(cleanUps[0].args[0]).toBe(client);
            expect(cleanUps[0].args[1]).toBe(failure);
        },

        useClientInScope(): Promise<void> {
            return state().uow.withClient(async (c) => {
                await c.query("SELECT 1");
            });
        },

        expectNoStatementAfterCleanUp(): void {
            const { cleanUps, client } = state();
            expect(cleanUps).toHaveLength(1);
            expect(client.statements).toEqual(cleanUps[0].statementsSentBefore);
        },

        expectCleanUpFailureReported(
            reportedErrors: ReturnType<typeof captureReportedErrors>
        ): void {
            expect(reportedErrors).toHaveBeenCalledWith(
                "PostgresUnitOfWork client cleanup failed",
                state().cleanUpFailure
            );
        },

        expectRollbackFailureReported(
            reportedErrors: ReturnType<typeof captureReportedErrors>,
            rollbackFailure: unknown
        ): void {
            expect(reportedErrors).toHaveBeenCalledWith(
                "PostgresUnitOfWork could not roll back a transaction",
                rollbackFailure
            );
        },
    };
}
