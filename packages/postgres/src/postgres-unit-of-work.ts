import { AsyncLocalStorage } from "node:async_hooks";

import * as pg from "pg";

import { Propagation, TransactionHooks } from "@hexaijs/core";
import { PostgresConfig } from "./config/index.js";
import { IsolationLevel } from "./types.js";
import {
    ClientCleanUp,
    ClientFactory,
    PostgresTransactionOptions,
} from "./types.js";
import { ensureConnection } from "./helpers.js";
import {
    type PostgresQueryable,
    singleStatementQuery,
} from "./postgres-queryable.js";
import type {
    BeforeCommitOptions,
    TransactionLifecycle,
    TransactionHook,
    UnitOfWorkClientAccess,
} from "@hexaijs/core";

/**
 * The cleanup the unit of work actually calls. It widens the public
 * `ClientCleanUp` with the failure that left the client in an unknown state,
 * so a pool-backed cleanup can destroy the client instead of reusing it.
 * Every `ClientCleanUp` is assignable to it, so the public type stays as is.
 */
type FailureAwareClientCleanUp = (
    client: pg.ClientBase,
    failure?: unknown
) => void | Promise<void>;

/**
 * What happens to a connection borrowed outside any scope when the work on it
 * fails. `db.query()` discards it, as `pool.query()` does, because the
 * connection may still be busy with the failed query, for example after pg's
 * `query_timeout`. `withClient()` releases it as usual, as code that releases
 * a client from `pool.connect()` in `finally` does, and as it always has.
 */
type BorrowedClientOnFailure = "discard" | "release";

declare const transactionResourceKeyBrand: unique symbol;

export interface TransactionResourceKey<T> {
    readonly symbol: symbol;
    readonly description: string;
    readonly [transactionResourceKeyBrand]?: (value: T) => T;
}

export function createTransactionResourceKey<T>(
    description: string
): TransactionResourceKey<T> {
    return {
        symbol: Symbol(description),
        description,
    };
}

export interface CommitControl {
    preventCommit(cause?: unknown): void;
    isCommitPrevented(): boolean;
}

export interface TransactionResources {
    getTransactionResource<T>(
        key: TransactionResourceKey<T>
    ): T | undefined;
    getOrCreateTransactionResource<T>(
        key: TransactionResourceKey<T>,
        factory: () => T
    ): T;
    setTransactionResource<T>(
        key: TransactionResourceKey<T>,
        value: T
    ): void;
}

/** @deprecated Use TransactionResources. */
export type TransactionResourceAware = TransactionResources;

export class TransactionAbortedError extends Error {
    constructor(cause?: unknown) {
        super("Transaction was already aborted before root scope completed", {
            cause,
        });
        this.name = "TransactionAbortedError";
    }
}

export class TransactionClosedError extends Error {
    constructor(operation: string = "Transaction") {
        super(`${operation} cannot use a transaction that has already closed`);
        this.name = "TransactionClosedError";
    }
}

export class UnsupportedNestedTransactionCapabilityError extends Error {
    constructor(operation: string = "Transaction capabilities") {
        super(`${operation} is not supported inside nested savepoints`);
        this.name = "UnsupportedNestedTransactionCapabilityError";
    }
}

export class IncompatibleIsolationLevelError extends Error {
    constructor(requested: IsolationLevel, current: IsolationLevel) {
        super(
            `A scope that requests isolation level ${requested} cannot join a transaction running at ${current}`
        );
        this.name = "IncompatibleIsolationLevelError";
    }
}

export interface PostgresUnitOfWorkObserver {
    onEveryCommit(observer: TransactionHook): () => void;
}

export interface PostgresUnitOfWork
    extends Omit<
            UnitOfWorkClientAccess<pg.ClientBase, PostgresTransactionOptions>,
            "wrap"
        >,
        TransactionLifecycle,
        PostgresUnitOfWorkObserver {
    /**
     * Runs queries in the transaction of the current scope. It is always the
     * same object, so keep it and use it at any time: each query goes to the
     * transaction that is current when it is called. Inside a scope, the first
     * query begins the transaction, and a query made after the scope's outcome
     * is decided rejects with `TransactionClosedError`. Outside any scope, each
     * query borrows a connection for itself and commits on its own, as
     * `pool.query()` does. Every call sends exactly one statement.
     */
    readonly db: PostgresQueryable;

    /**
     * @deprecated Use `db` for queries. Work that needs the pg client itself,
     * such as COPY, can keep using withClient() for now; its replacement will
     * be decided before withClient() is removed in the next major version.
     */
    withClient<T>(fn: (client: pg.ClientBase) => Promise<T>): Promise<T>;

    /** @deprecated Use `db`. getClient() will be removed in the next major version. */
    getClient(): pg.ClientBase;
}

export class DefaultPostgresUnitOfWork
    implements PostgresUnitOfWork, CommitControl, TransactionResources {
    private transactionStorage = new AsyncLocalStorage<PostgresTransaction>();
    private everyCommitObservers = new Set<TransactionHook>();

    readonly db: PostgresQueryable = {
        query: async (text, values) => {
            const query = singleStatementQuery(text, values);
            return this.useClient(
                (client) => client.query(query),
                "db.query()",
                "discard"
            );
        },
    };

    private readonly clientCleanUp?: FailureAwareClientCleanUp;

    constructor(
        private clientFactory: ClientFactory,
        clientCleanUp?: ClientCleanUp
    ) {
        this.clientCleanUp = clientCleanUp;
    }

    /** @deprecated Use `db`. getClient() will be removed in the next major version. */
    public getClient(): pg.ClientBase {
        const current = this.getCurrentTransaction();

        if (!current) {
            throw new Error("Unit of work not started");
        }

        return current.getClient();
    }

    async scope<T = unknown>(
        fn: () => Promise<T>,
        options: Partial<PostgresTransactionOptions> = {}
    ): Promise<T> {
        const resolvedOptions = this.resolveOptions(options);
        const { transaction, created } =
            this.resolveTransaction(resolvedOptions);

        return this.executeInContext(transaction, (tx) =>
            created
                ? tx.ownScope(fn, resolvedOptions)
                : tx.joinScope(fn, resolvedOptions)
        );
    }

    beforeCommit(
        hook: TransactionHook,
        options?: BeforeCommitOptions
    ): void {
        const tx = this.getRequiredTransaction("beforeCommit");
        tx.addBeforeCommitHook(hook, options);
    }

    afterCommit(hook: TransactionHook): void {
        const tx = this.getRequiredTransaction("afterCommit");
        tx.addAfterCommitHook(() => this.runOutsideTransactionContext(hook));
    }

    afterRollback(hook: TransactionHook): void {
        const tx = this.getRequiredTransaction("afterRollback");
        tx.addAfterRollbackHook(() => this.runOutsideTransactionContext(hook));
    }

    onEveryCommit(observer: TransactionHook): () => void {
        this.everyCommitObservers.add(observer);

        let subscribed = true;
        return () => {
            if (!subscribed) {
                return;
            }

            subscribed = false;
            this.everyCommitObservers.delete(observer);
        };
    }

    preventCommit(cause?: unknown): void {
        const tx = this.getRequiredTransaction("preventCommit");
        tx.preventCommit(cause);
    }

    isCommitPrevented(): boolean {
        const tx = this.getRequiredTransaction("isCommitPrevented");
        return tx.isCommitPrevented();
    }

    getTransactionResource<T>(
        key: TransactionResourceKey<T>
    ): T | undefined {
        const tx = this.getRequiredTransaction("getTransactionResource");
        return tx.getResource(key);
    }

    getOrCreateTransactionResource<T>(
        key: TransactionResourceKey<T>,
        factory: () => T
    ): T {
        const tx = this.getRequiredTransaction(
            "getOrCreateTransactionResource"
        );
        return tx.getOrCreateResource(key, factory);
    }

    setTransactionResource<T>(
        key: TransactionResourceKey<T>,
        value: T
    ): void {
        const tx = this.getRequiredTransaction("setTransactionResource");
        tx.setResource(key, value);
    }

    /** @deprecated Use `db` for queries. See `PostgresUnitOfWork.withClient()`. */
    withClient<T>(fn: (client: pg.ClientBase) => Promise<T>): Promise<T> {
        return this.useClient(fn, "withClient()", "release");
    }

    private async useClient<T>(
        fn: (client: pg.ClientBase) => Promise<T>,
        operation: string,
        borrowedClientOnFailure: BorrowedClientOnFailure
    ): Promise<T> {
        const currentTransaction = this.getCurrentTransaction();

        if (currentTransaction) {
            return currentTransaction.useClient(fn, operation);
        }

        return this.useBorrowedClient(fn, borrowedClientOnFailure);
    }

    private async useBorrowedClient<T>(
        fn: (client: pg.ClientBase) => Promise<T>,
        onFailure: BorrowedClientOnFailure
    ): Promise<T> {
        const client = await this.clientFactory();
        let result: T;
        try {
            await ensureConnection(client);
            result = await fn(client);
        } catch (failure) {
            if (onFailure === "discard") {
                await this.clientCleanUp?.(client, failure);
            } else {
                await this.clientCleanUp?.(client);
            }
            throw failure;
        }
        await this.clientCleanUp?.(client);
        return result;
    }

    private getCurrentTransaction(): PostgresTransaction | null {
        return this.transactionStorage.getStore() ?? null;
    }

    private getRequiredTransaction(operation: string): PostgresTransaction {
        const tx = this.getCurrentTransaction();
        if (!tx) {
            throw new Error(
                `Cannot use ${operation} outside of a transaction scope`
            );
        }
        if (tx.isClosed()) {
            throw new TransactionClosedError(operation);
        }
        return tx;
    }

    private runOutsideTransactionContext(
        hook: TransactionHook
    ): void | Promise<void> {
        return this.transactionStorage.exit(() => hook());
    }

    private async notifyEveryCommit(): Promise<void> {
        const observers = Array.from(this.everyCommitObservers);
        if (observers.length === 0) {
            return;
        }

        await this.transactionStorage.exit(async () => {
            for (const observer of observers) {
                try {
                    await observer();
                } catch (e) {
                    console.error(
                        "PostgresUnitOfWork onEveryCommit observer failed",
                        e
                    );
                }
            }
        });
    }

    private resolveOptions(
        options: Partial<PostgresTransactionOptions>
    ): PostgresTransactionOptions {
        return {
            propagation: Propagation.EXISTING,
            ...options,
        };
    }

    // The call that creates a transaction owns it: only that call finalizes
    // it. Calls that join an existing transaction take part without ending it.
    private resolveTransaction(options: PostgresTransactionOptions): {
        transaction: PostgresTransaction;
        created: boolean;
    } {
        const current = this.getCurrentTransaction();
        return current && options.propagation !== Propagation.NEW
            ? { transaction: current, created: false }
            : { transaction: this.createTransaction(), created: true };
    }

    private createTransaction(): PostgresTransaction {
        return new PostgresTransaction(
            this.clientFactory,
            this.clientCleanUp,
            () => this.notifyEveryCommit()
        );
    }

    private executeInContext<T>(
        transaction: PostgresTransaction,
        callback: (transaction: PostgresTransaction) => Promise<T>
    ): Promise<T> {
        return this.transactionStorage.run(transaction, () =>
            callback(transaction)
        );
    }
}

/**
 * Where the transaction is in its life. Only the owner's finalization moves it
 * forward.
 * - open: accepts work.
 * - committing: runs beforeCommit hooks; only work from those hooks is
 *   accepted, so nothing else slips in between the hooks and COMMIT.
 * - closed: the outcome is decided. No statement gets in any more, and the
 *   final statement waits only for the statements already queued.
 */
type TransactionPhase = "open" | "committing" | "closed";

/** How far the connection and the server-side transaction have come. */
type TransactionStart =
    | { readonly state: "idle" }
    | { readonly state: "acquiring" }
    | { readonly state: "beginning"; readonly client: pg.ClientBase }
    | { readonly state: "begun"; readonly client: pg.ClientBase }
    | {
          readonly state: "failed";
          readonly client?: pg.ClientBase;
          readonly began: boolean;
          readonly failure: unknown;
      }
    | { readonly state: "released" };

type Settlement<T> = { readonly value: T } | { readonly error: unknown };

interface RollbackDecision<T> {
    readonly kind: "rollback";
    readonly cause: unknown;
    readonly settlement: Settlement<T>;
}

type Decision<T> =
    | { readonly kind: "commit"; readonly value: T }
    | { readonly kind: "close"; readonly value: T }
    | RollbackDecision<T>;

type EndResult = "ended" | "ended as rollback";

// Marks work running inside a transaction's beforeCommit hooks, the only work
// a committing transaction still accepts.
const beforeCommitHookScope = new AsyncLocalStorage<PostgresTransaction>();

// The savepoint whose callback is running, so a NESTED scope can tell a child
// of the open savepoint from a sibling that would interleave with it.
const savepointScope = new AsyncLocalStorage<Savepoint>();

// Thrown by a start that gave up on its client: the outcome was decided
// before the client arrived.
class StartAbandoned extends Error {
    constructor() {
        super(
            "The transaction start was abandoned because its outcome was decided"
        );
        this.name = "StartAbandoned";
    }
}

// Thrown from inside TransactionHooks.executeCommit() so that afterCommit
// hooks are skipped when the final decision turns into a rollback.
class CommitWithdrawn extends Error {
    constructor(readonly decision: RollbackDecision<unknown>) {
        super("Commit withdrawn");
        this.name = "CommitWithdrawn";
    }
}

/**
 * Sends a transaction's statements to its connection one at a time, in the
 * order they were queued. Each statement settles on its own, so a failure
 * does not hold up the statements behind it. pg's own queue for overlapping
 * queries is deprecated, so the connection never gets two at once.
 *
 * The line keeps its own promise of each turn. The promise a caller receives
 * has no handler attached here, so a rejection nobody handles still surfaces.
 */
class StatementLine {
    private lastTurn: Promise<void> = Promise.resolve();
    private turnsInLine = 0;

    enqueue<T>(send: () => Promise<T>): Promise<T> {
        const previousTurn = this.lastTurn;
        const endTurn = this.takeTurn();
        return previousTurn.then(async () => {
            try {
                return await send();
            } finally {
                endTurn();
            }
        });
    }

    // Like enqueue(), but an empty line starts `send` within this call, as pg
    // hands a query to an idle connection within query().
    enqueueOrStart(send: () => Promise<void>): Promise<void> {
        if (this.turnsInLine > 0) {
            return this.enqueue(send);
        }
        const endTurn = this.takeTurn();
        return send().finally(endTurn);
    }

    private takeTurn(): () => void {
        this.turnsInLine += 1;
        let endTurn!: () => void;
        this.lastTurn = new Promise<void>((resolve) => {
            endTurn = resolve;
        });
        return () => {
            this.turnsInLine -= 1;
            endTurn();
        };
    }
}

class PostgresTransaction {
    private phase: TransactionPhase = "open";
    private start: TransactionStart = { state: "idle" };
    private started?: Promise<pg.ClientBase>;
    private gatedClient?: pg.ClientBase;
    private abandonAcquisition?: () => void;
    private readonly statements = new StatementLine();
    private abort?: { readonly cause: unknown };
    private commitPrevention?: { readonly cause: unknown };
    private lastStatementFailure?: { readonly failure: unknown };
    private options!: PostgresTransactionOptions;

    private readonly savepoints: Savepoint[] = [];
    private readonly hooks = new TransactionHooks();
    private readonly resources = new Map<symbol, unknown>();

    constructor(
        private readonly clientFactory: ClientFactory,
        private readonly clientCleanUp: FailureAwareClientCleanUp | undefined,
        private readonly notifyRootCommit: () => Promise<void>
    ) {}

    public addBeforeCommitHook(
        hook: TransactionHook,
        options?: BeforeCommitOptions
    ): void {
        this.hooks.addBeforeCommit(
            () => beforeCommitHookScope.run(this, () => hook()),
            options?.phase
        );
    }

    public addAfterCommitHook(hook: TransactionHook): void {
        this.hooks.addAfterCommit(hook);
    }

    public addAfterRollbackHook(hook: TransactionHook): void {
        this.hooks.addAfterRollback(hook);
    }

    public preventCommit(cause?: unknown): void {
        this.assertNotInNestedSavepoint("preventCommit()");
        this.commitPrevention ??= { cause };
    }

    public isCommitPrevented(): boolean {
        this.assertNotInNestedSavepoint("isCommitPrevented()");
        return this.commitPrevention !== undefined;
    }

    public getResource<T>(
        key: TransactionResourceKey<T>
    ): T | undefined {
        this.assertNotInNestedSavepoint("Transaction resources");
        return this.resources.get(key.symbol) as T | undefined;
    }

    public getOrCreateResource<T>(
        key: TransactionResourceKey<T>,
        factory: () => T
    ): T {
        this.assertNotInNestedSavepoint("Transaction resources");
        if (!this.resources.has(key.symbol)) {
            this.resources.set(key.symbol, factory());
        }
        return this.resources.get(key.symbol) as T;
    }

    public setResource<T>(
        key: TransactionResourceKey<T>,
        value: T
    ): void {
        this.assertNotInNestedSavepoint("Transaction resources");
        this.resources.set(key.symbol, value);
    }

    public async ownScope<T>(
        fn: () => Promise<T>,
        options: PostgresTransactionOptions
    ): Promise<T> {
        this.options = options;
        return this.finalize(await settlementOf(fn));
    }

    // The owner's options alone decide how the transaction starts, whichever
    // call happens to trigger the start. A participant that asks for another
    // isolation level is refused rather than silently given the owner's.
    public async joinScope<T>(
        fn: () => Promise<T>,
        options: PostgresTransactionOptions
    ): Promise<T> {
        this.assertAdmits("scope()");
        this.assertSameIsolationLevel(options);
        if (options.propagation !== Propagation.NESTED) {
            return this.abortingOnFailure(fn);
        }

        this.assertNoSiblingSavepoint();
        await this.waitForStart("scope()");
        // The outcome may have been decided while the start was pending.
        this.assertAdmits("scope()");
        return this.createSavepoint().execute(fn);
    }

    public async useClient<T>(
        fn: (client: pg.ClientBase) => Promise<T>,
        operation: string
    ): Promise<T> {
        this.assertAdmits(operation);
        const client = await this.waitForStart(operation);
        // The outcome may have been decided while the start was pending.
        this.assertAdmits(operation);
        return fn(client);
    }

    public getClient(): pg.ClientBase {
        this.assertAdmits("getClient()");
        if (!this.gatedClient) {
            throw new Error(
                "Transaction not initialized: no query has started it yet. getClient() is deprecated; use db, whose first query inside scope() starts the transaction."
            );
        }
        return this.gatedClient;
    }

    public isClosed(): boolean {
        return !this.admits();
    }

    private async finalize<T>(outcome: Settlement<T>): Promise<T> {
        const decision = this.decide(outcome);
        if (decision.kind === "close") {
            await this.end("ROLLBACK");
            return decision.value;
        }
        if (decision.kind === "rollback") {
            return this.rollBack(decision);
        }
        return this.commit(decision.value);
    }

    private decide<T>(outcome: Settlement<T>): Decision<T> {
        if ("error" in outcome) {
            return {
                kind: "rollback",
                cause: outcome.error,
                settlement: outcome,
            };
        }
        if (this.abort && !this.commitPrevention) {
            const error = new TransactionAbortedError(this.abort.cause);
            return { kind: "rollback", cause: error, settlement: { error } };
        }
        const rollbackCause = this.abort ?? this.commitPrevention;
        if (rollbackCause) {
            return {
                kind: "rollback",
                cause: rollbackCause.cause,
                settlement: outcome,
            };
        }
        return this.start.state === "begun"
            ? { kind: "commit", value: outcome.value }
            : { kind: "close", value: outcome.value };
    }

    private async commit<T>(value: T): Promise<T> {
        this.phase = "committing";
        let committed = false;
        try {
            await this.hooks.executeCommit(
                async () => {
                    // The hooks and the work they started may have aborted the
                    // transaction or prevented the commit.
                    const decision = this.decide<T>({ value });
                    if (decision.kind === "rollback") {
                        this.close();
                        throw new CommitWithdrawn(decision);
                    }
                    if ((await this.end("COMMIT")) === "ended as rollback") {
                        throw new CommitWithdrawn(this.endedAsRollback());
                    }
                    committed = true;
                },
                async () => {
                    await this.end("ROLLBACK");
                }
            );
            return value;
        } catch (e) {
            if (e instanceof CommitWithdrawn) {
                return this.rollBack(e.decision as RollbackDecision<T>);
            }
            throw e;
        } finally {
            if (committed) {
                await this.notifyRootCommit();
            }
        }
    }

    // PostgreSQL answers COMMIT with ROLLBACK instead of an error when a
    // statement had already failed inside the transaction, so nothing was
    // committed. The last failed statement is the most likely reason.
    private endedAsRollback(): RollbackDecision<never> {
        const error = new TransactionAbortedError(
            this.lastStatementFailure?.failure
        );
        return { kind: "rollback", cause: error, settlement: { error } };
    }

    private async rollBack<T>(decision: RollbackDecision<T>): Promise<T> {
        await this.hooks.executeRollback(async () => {
            await this.end("ROLLBACK");
        }, decision.cause);
        if ("error" in decision.settlement) {
            throw decision.settlement.error;
        }
        return decision.settlement.value;
    }

    // From the moment the outcome is decided nothing gets in: statements are
    // refused, and a start still waiting for a pooled client gives up. Work
    // that is still running is not waited for.
    private close(): void {
        if (this.phase === "closed") {
            return;
        }
        this.phase = "closed";
        this.resources.clear();
        this.abandonAcquisition?.();
    }

    // Closes the transaction and queues the final statement in the same step,
    // behind the statements that got in before, so it never overtakes one of
    // them and nothing reaches the connection after it.
    private end(statement: "COMMIT" | "ROLLBACK"): Promise<EndResult> {
        this.close();
        return this.statements.enqueue(() =>
            this.sendFinalStatement(statement)
        );
    }

    // Ends the transaction exactly once: sends the final statement when BEGIN
    // succeeded, then releases the client. A failed statement leaves the
    // connection in an unknown state, so its failure goes to the cleanup,
    // which destroys a pooled client. A failed ROLLBACK cannot change the
    // outcome, since a destroyed connection's transaction is discarded, so it
    // is only reported.
    private async sendFinalStatement(
        statement: "COMMIT" | "ROLLBACK"
    ): Promise<EndResult> {
        const held = this.takeClient();
        if (!held) {
            return "ended";
        }

        let failure = held.startFailure;
        let statementFailure: { failure: unknown } | undefined;
        let endedAsRollback = false;
        if (held.began) {
            try {
                const result = await held.client.query(statement);
                endedAsRollback =
                    statement === "COMMIT" && result?.command === "ROLLBACK";
            } catch (e) {
                statementFailure = { failure: e };
                failure = statementFailure;
            }
        }
        await this.release(held.client, failure);

        if (statementFailure && statement === "COMMIT") {
            throw statementFailure.failure;
        }
        if (statementFailure) {
            console.error(
                "PostgresUnitOfWork could not roll back a transaction",
                statementFailure.failure
            );
        }
        return endedAsRollback ? "ended as rollback" : "ended";
    }

    // A client still being acquired is not taken: its start hands it back as
    // soon as it arrives and sees that the transaction no longer wants it. A
    // start whose statements were queued has settled by the time the final
    // statement's turn comes.
    private takeClient():
        | {
              client: pg.ClientBase;
              began: boolean;
              startFailure?: { failure: unknown };
          }
        | undefined {
        const start = this.start;
        if (
            (start.state !== "begun" && start.state !== "failed") ||
            !start.client
        ) {
            return undefined;
        }

        this.start = { state: "released" };
        if (start.state === "begun") {
            return { client: start.client, began: true };
        }
        return {
            client: start.client,
            began: start.began,
            startFailure: start.began ? undefined : { failure: start.failure },
        };
    }

    // Every caller waits for the same start, so an abandoned start is reported
    // under the operation of each caller rather than the one that triggered it.
    private async waitForStart(operation: string): Promise<pg.ClientBase> {
        this.started ??= this.startTransaction();
        try {
            return await this.started;
        } catch (e) {
            throw e instanceof StartAbandoned
                ? new TransactionClosedError(operation)
                : e;
        }
    }

    private async startTransaction(): Promise<pg.ClientBase> {
        this.start = { state: "acquiring" };
        const client = await this.acquireUnlessDecided();
        if (!this.isUndecided()) {
            // The outcome was decided between the client's arrival and this
            // check, so the transaction never adopted it; it goes back without
            // SQL.
            this.start = { state: "released" };
            await this.release(client);
            throw new StartAbandoned();
        }

        this.start = { state: "beginning", client };
        this.gatedClient = createGatedClient(client, {
            send: (args) => this.sendStatement("query()", client, args),
            submit: (args) => this.submitStatement("query()", client, args),
        });
        await this.statements.enqueue(() => this.sendStartStatements(client));
        return this.gatedClient;
    }

    private acquireUnlessDecided(): Promise<pg.ClientBase> {
        return new Promise((resolve, reject) => {
            let abandoned = false;
            this.abandonAcquisition = () => {
                abandoned = true;
                this.abandonAcquisition = undefined;
                reject(this.abandonStart());
            };
            this.acquireClient().then(
                (client) => {
                    this.abandonAcquisition = undefined;
                    if (abandoned) {
                        void this.release(client);
                    } else {
                        resolve(client);
                    }
                },
                (failure) => {
                    this.abandonAcquisition = undefined;
                    if (abandoned) {
                        console.error(
                            "PostgresUnitOfWork could not acquire a client for an abandoned transaction start",
                            failure
                        );
                    } else {
                        reject(failure);
                    }
                }
            );
        });
    }

    private abandonStart(): StartAbandoned {
        const abandonment = new StartAbandoned();
        this.failStart({ began: false, failure: abandonment });
        return abandonment;
    }

    private async acquireClient(): Promise<pg.ClientBase> {
        let client: unknown;
        try {
            client = await this.clientFactory();
            if (!isClient(client)) {
                throw new Error("Client factory must return a pg.ClientBase");
            }
            await ensureConnection(client);
            return client;
        } catch (failure) {
            this.failStart({ began: false, failure });
            if (isClient(client)) {
                await this.release(client, { failure });
            }
            throw failure;
        }
    }

    private async sendStartStatements(client: pg.ClientBase): Promise<void> {
        let began = false;
        try {
            await client.query("BEGIN");
            began = true;

            const isolationLevel =
                this.options.isolationLevel ?? IsolationLevel.READ_COMMITTED;
            if (isolationLevel !== IsolationLevel.READ_COMMITTED) {
                await client.query(
                    `SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`
                );
            }
        } catch (failure) {
            this.failStart({ client, began, failure });
            throw failure;
        }
        this.start = { state: "begun", client };
    }

    // A transaction whose start failed cannot be committed.
    private failStart(start: {
        client?: pg.ClientBase;
        began: boolean;
        failure: unknown;
    }): void {
        this.start = { state: "failed", ...start };
        if (this.isUndecided()) {
            this.abort ??= { cause: start.failure };
        }
    }

    // The only place a client is handed back. Each client reaches it once:
    // from the final statement after the transaction adopted it, or from its
    // start when the transaction never did.
    private async release(
        client: pg.ClientBase,
        failure?: { failure: unknown }
    ): Promise<void> {
        try {
            if (failure) {
                await this.clientCleanUp?.(client, failure.failure);
            } else {
                await this.clientCleanUp?.(client);
            }
        } catch (cleanUpFailure) {
            console.error(
                "PostgresUnitOfWork client cleanup failed",
                cleanUpFailure
            );
        }
    }

    // Every statement after the start passes here, whether it comes from user
    // code or from a savepoint: refused once the transaction stops accepting
    // work, otherwise queued behind the statements that got in before it.
    private sendStatement(
        operation: string,
        client: pg.ClientBase,
        args: unknown[]
    ): Promise<pg.QueryResult> {
        if (!this.admits()) {
            return Promise.reject(new TransactionClosedError(operation));
        }
        const query = client.query as (
            ...queryArgs: unknown[]
        ) => Promise<pg.QueryResult>;
        return this.statements.enqueue(async () => {
            try {
                return await query.apply(client, args);
            } catch (failure) {
                this.lastStatementFailure = { failure };
                throw failure;
            }
        });
    }

    // A submittable, such as a cursor, takes its turn in the same line. It
    // reports its results through its own events rather than a promise, so
    // its turn ends when pg tells it the connection is done with it. On an
    // empty line it reaches the connection within the call, because a cursor
    // only closes once it has reached the connection.
    private submitStatement(
        operation: string,
        client: pg.ClientBase,
        args: unknown[]
    ): void {
        this.assertAdmits(operation);
        const submit = client.query as (...queryArgs: unknown[]) => unknown;
        void this.statements.enqueueOrStart(
            () =>
                new Promise<void>((endTurn) => {
                    watchSubmittableEnd(args[0] as SubmittableQuery, {
                        onFailure: (failure) => {
                            this.lastStatementFailure = { failure };
                        },
                        onEnd: endTurn,
                    });
                    submit.apply(client, args);
                })
        );
    }

    // A participant's failure poisons the transaction even if an outer scope
    // swallows it.
    private async abortingOnFailure<T>(fn: () => Promise<T>): Promise<T> {
        try {
            return await fn();
        } catch (failure) {
            this.abort ??= { cause: failure };
            throw failure;
        }
    }

    private isUndecided(): boolean {
        return this.phase !== "closed";
    }

    private admits(): boolean {
        return (
            this.phase === "open" ||
            (this.phase === "committing" &&
                beforeCommitHookScope.getStore() === this)
        );
    }

    private assertAdmits(operation: string): void {
        if (!this.admits()) {
            throw new TransactionClosedError(operation);
        }
    }

    private assertSameIsolationLevel(options: PostgresTransactionOptions): void {
        const current =
            this.options.isolationLevel ?? IsolationLevel.READ_COMMITTED;
        const requested = options.isolationLevel;
        if (requested !== undefined && requested !== current) {
            throw new IncompatibleIsolationLevelError(requested, current);
        }
    }

    // Only called once the start has succeeded: a failed start rejects the
    // NESTED scope while it waits for it.
    private createSavepoint(): Savepoint {
        this.assertNoSiblingSavepoint();
        const start = this.start;
        if (start.state !== "begun") {
            throw new TransactionClosedError("Nested savepoint");
        }
        const savepoint = new Savepoint(`sp_${this.savepoints.length + 1}`, {
            admitsWork: () => this.admits(),
            send: (sql) =>
                this.sendStatement("Nested savepoint", start.client, [sql]),
            remove: (closed) => this.removeSavepoint(closed),
        });
        this.savepoints.push(savepoint);
        return savepoint;
    }

    // Savepoints form a stack on the connection, so a NESTED scope opened
    // beside an open savepoint would interleave its statements with it.
    private assertNoSiblingSavepoint(): void {
        const innermost = this.findActiveSavepoint();
        if (innermost && savepointScope.getStore() !== innermost) {
            throw new UnsupportedNestedTransactionCapabilityError(
                "Opening a concurrent sibling NESTED scope"
            );
        }
    }

    private findActiveSavepoint(): Savepoint | undefined {
        for (let i = this.savepoints.length - 1; i >= 0; i--) {
            if (!this.savepoints[i].isClosed()) {
                return this.savepoints[i];
            }
        }
    }

    private removeSavepoint(savepoint: Savepoint): void {
        const index = this.savepoints.lastIndexOf(savepoint);
        if (index !== -1) {
            this.savepoints.splice(index, 1);
        }
    }

    // Read from the calling context, so the owner's context keeps these
    // capabilities while a NESTED scope runs beside it. A NEW transaction
    // opened inside a savepoint is not inside one of its own.
    private assertNotInNestedSavepoint(operation: string): void {
        const savepoint = savepointScope.getStore();
        if (savepoint && this.savepoints.includes(savepoint)) {
            throw new UnsupportedNestedTransactionCapabilityError(operation);
        }
    }
}

interface SavepointHost {
    admitsWork(): boolean;
    send(sql: string): Promise<unknown>;
    remove(savepoint: Savepoint): void;
}

class Savepoint {
    private closed = false;

    constructor(
        private readonly name: string,
        private readonly host: SavepointHost
    ) {}

    public async execute<T>(fn: () => Promise<T>): Promise<T> {
        await this.host.send(`SAVEPOINT ${this.name}`);
        // The outcome may have been decided while SAVEPOINT was pending, and
        // every query of the callback would be refused.
        if (!this.host.admitsWork()) {
            this.closed = true;
            throw new TransactionClosedError("Nested savepoint");
        }

        let result: T;
        try {
            result = await savepointScope.run(this, fn);
        } catch (failure) {
            await this.rollBackAfter(failure);
            throw failure;
        }
        await this.end(`RELEASE SAVEPOINT ${this.name}`);
        return result;
    }

    public isClosed(): boolean {
        return this.closed;
    }

    // The callback's failure is what its caller needs to see, so a failed
    // ROLLBACK TO SAVEPOINT, for example one refused because the transaction
    // was decided meanwhile, is only reported.
    private async rollBackAfter(failure: unknown): Promise<void> {
        try {
            await this.end(`ROLLBACK TO SAVEPOINT ${this.name}`);
        } catch (rollbackFailure) {
            console.error(
                "PostgresUnitOfWork could not roll back to a savepoint after a failure",
                rollbackFailure,
                failure
            );
        }
    }

    private async end(statement: string): Promise<void> {
        this.closed = true;
        await this.host.send(statement);
        this.host.remove(this);
    }
}

interface QueryGate {
    send(args: unknown[]): Promise<pg.QueryResult>;
    submit(args: unknown[]): void;
}

interface SubmittableQuery {
    handleReadyForQuery(...args: unknown[]): unknown;
    handleError(failure: unknown, ...args: unknown[]): unknown;
}

// pg ends a submittable's use of the connection with exactly one of these
// calls: handleReadyForQuery after it completes, or handleError when the
// server reports an error, the query cannot be sent or the connection is lost.
// pg's own queries settle their promises on the same two calls.
function watchSubmittableEnd(
    submittable: SubmittableQuery,
    listener: { onFailure(failure: unknown): void; onEnd(): void }
): void {
    const handleReadyForQuery = submittable.handleReadyForQuery;
    const handleError = submittable.handleError;
    let ended = false;
    const end = () => {
        if (ended) {
            return;
        }
        ended = true;
        listener.onEnd();
    };

    submittable.handleReadyForQuery = function (...args) {
        try {
            return handleReadyForQuery.apply(this, args);
        } finally {
            end();
        }
    };
    submittable.handleError = function (failure, ...args) {
        listener.onFailure(failure);
        try {
            return handleError.call(this, failure, ...args);
        } finally {
            end();
        }
    };
}

type QueryCallback = (error: unknown, result?: pg.QueryResult) => void;

// The connection belongs to the unit of work for the whole transaction:
// releasing, ending or reconnecting it from inside would hand it to another
// borrower or break the transaction.
const TRANSACTION_OWNED_MEMBERS: ReadonlySet<PropertyKey> = new Set([
    "release",
    "end",
    "connect",
]);

class TransactionOwnsClientError extends Error {
    constructor(member: string) {
        super(
            `${member}() cannot be called on a client a transaction owns; the unit of work releases it when the transaction ends`
        );
        this.name = "TransactionOwnsClientError";
    }
}

/**
 * The client that code inside a transaction receives. Its queries go through
 * the transaction: refused once the transaction stops accepting work,
 * otherwise sent one at a time ahead of the final statement. A query in
 * callback form takes the same way and gets its result through the callback.
 * A submittable, such as a cursor, is returned at once and sent when its turn
 * comes, as pg does: within the call on an idle connection, later on a busy
 * one.
 * Every other member is the real client's, called on it, and a method that
 * returns the real client returns this one instead.
 */
function createGatedClient(
    client: pg.ClientBase,
    gate: QueryGate
): pg.ClientBase {
    const delegates = new Map<
        PropertyKey,
        { original: unknown; delegate: unknown }
    >();
    const query = (...args: unknown[]): unknown =>
        routeQuery(gate, args);

    const gated: pg.ClientBase = new Proxy(client, {
        get(target, property) {
            if (property === "query") {
                return query;
            }
            if (TRANSACTION_OWNED_MEMBERS.has(property)) {
                return () => {
                    throw new TransactionOwnsClientError(String(property));
                };
            }

            const value: unknown = Reflect.get(target, property, target);
            if (typeof value !== "function") {
                return value;
            }
            const known = delegates.get(property);
            if (known?.original === value) {
                return known.delegate;
            }
            const original = value as (...args: unknown[]) => unknown;
            const delegate = (...args: unknown[]): unknown => {
                const result = original.apply(target, args);
                return result === target ? gated : result;
            };
            delegates.set(property, { original, delegate });
            return delegate;
        },
    });
    return gated;
}

function routeQuery(gate: QueryGate, args: unknown[]): unknown {
    if (isSubmittable(args[0])) {
        gate.submit(args);
        return args[0];
    }

    const { queryArgs, callback } = takeQueryCallback(args);
    const result = gate.send(copyQueryConfig(queryArgs));
    if (!callback) {
        return result;
    }
    result.then(
        (queryResult) => callback(null, queryResult),
        (error: unknown) => callback(error)
    );
    return undefined;
}

// pg takes the callback as the last argument or as the config's `callback`.
function takeQueryCallback(args: unknown[]): {
    queryArgs: unknown[];
    callback?: QueryCallback;
} {
    const last = args[args.length - 1];
    if (args.length > 1 && typeof last === "function") {
        return {
            queryArgs: args.slice(0, -1),
            callback: last as QueryCallback,
        };
    }

    const [config, ...rest] = args;
    if (
        typeof config === "object" &&
        config !== null &&
        typeof (config as { callback?: unknown }).callback === "function"
    ) {
        const { callback, ...queryConfig } = config as {
            callback: QueryCallback;
        };
        return { queryArgs: [queryConfig, ...rest], callback };
    }
    return { queryArgs: args };
}

// pg reads a query config when query() is called, while the line may send the
// query later, so the line gets the config as it was at the call. The copy
// keeps the prototype, where a config class such as an SQL template keeps
// getters like `text`.
function copyQueryConfig(args: unknown[]): unknown[] {
    const [config, ...rest] = args;
    if (typeof config !== "object" || config === null) {
        return args;
    }
    const copy: object = Object.assign(
        Object.create(Object.getPrototypeOf(config) as object | null) as object,
        config
    );
    return [copy, ...rest];
}

function isSubmittable(value: unknown): boolean {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { submit?: unknown }).submit === "function"
    );
}

async function settlementOf<T>(fn: () => Promise<T>): Promise<Settlement<T>> {
    try {
        return { value: await fn() };
    } catch (error) {
        return { error };
    }
}

function isClient(value: unknown): value is pg.ClientBase {
    return typeof value === "object" && value !== null && "query" in value;
}

export function createPostgresUnitOfWork(
    pool: pg.Pool
): DefaultPostgresUnitOfWork;
export function createPostgresUnitOfWork(
    config: PostgresConfig | string
): DefaultPostgresUnitOfWork;
export function createPostgresUnitOfWork(
    source: pg.Pool | PostgresConfig | string
): DefaultPostgresUnitOfWork {
    if (source instanceof pg.Pool) {
        return new DefaultPostgresUnitOfWork(
            async () => source.connect(),
            releasePoolClient
        );
    }

    const connectionString =
        source instanceof PostgresConfig ? source.toString() : source;

    return new DefaultPostgresUnitOfWork(
        () => new pg.Client({ connectionString }),
        (client) => (client as pg.Client).end()
    );
}

// The unit of work passes a second argument exactly when the client is in an
// unknown state, whatever the failure is: a query may reject with undefined.
function releasePoolClient(
    client: pg.ClientBase,
    ...failure: [] | [unknown]
): void {
    const poolClient = client as pg.PoolClient;
    if (failure.length === 0) {
        poolClient.release();
        return;
    }

    // pg-pool destroys a client released with a truthy argument instead of
    // returning it to the pool in an unknown state.
    const [cause] = failure;
    poolClient.release(cause instanceof Error ? cause : true);
}
