import type { Database } from "better-sqlite3";

import {
    DuplicateObjectError,
    Identifiable,
    IdOf,
    ObjectNotFoundError,
    Repository,
} from "@hexaijs/core";

export class SqliteRepositoryForTest<
    E extends Identifiable<any>,
    M,
> implements Repository<E> {
    protected namespace: string;
    protected hydrate: (memento: M) => E;
    protected dehydrate: (entity: E) => M;

    constructor(
        protected db: Database,
        {
            namespace,
            hydrate,
            dehydrate,
        }: {
            namespace: string;
            hydrate: (memento: M) => E;
            dehydrate: (entity: E) => M;
        }
    ) {
        this.namespace = namespace;
        this.hydrate = hydrate;
        this.dehydrate = dehydrate;
    }

    async get(id: IdOf<E>): Promise<E> {
        this.ensureTableExists();

        const row = this.db.prepare(
            `SELECT * FROM ${this.namespace} WHERE id = ?`
        ).get(id.getValue()) as { data: string } | undefined;
        if (!row) {
            throw new ObjectNotFoundError(
                `entity with id '${id.getValue()}' not found`
            );
        }

        return this.hydrate(JSON.parse(row.data));
    }

    async add(entity: E): Promise<void> {
        this.ensureTableExists();

        try {
            this.db.prepare(
                `INSERT INTO ${this.namespace} (id, data)
                 VALUES (?, ?)`
            ).run(
                entity.getId().getValue(),
                JSON.stringify(this.dehydrate(entity))
            );
        } catch (e) {
            if ((e as Error).message.includes("UNIQUE constraint failed")) {
                throw new DuplicateObjectError(
                    `entity with id '${entity
                        .getId()
                        .getValue()}' already exists`
                );
            }

            throw e;
        }
    }

    async update(entity: E): Promise<void> {
        this.ensureTableExists();

        const result = this.db.prepare(
            `UPDATE ${this.namespace}
                 SET data = ?
                 WHERE id = ?`
        ).run(
            JSON.stringify(this.dehydrate(entity)),
            entity.getId().getValue()
        );

        if (result.changes === 0) {
            throw new ObjectNotFoundError(
                `entity with id '${entity.getId().getValue()}' not found`
            );
        }
    }

    async count(): Promise<number> {
        this.ensureTableExists();

        const result = this.db.prepare(
            `SELECT COUNT(*) AS count FROM ${this.namespace}`
        ).get() as { count: number };

        return result.count;
    }

    protected ensureTableExists(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS ${this.namespace} (
                id TEXT NOT NULL PRIMARY KEY UNIQUE,
                data TEXT NOT NULL
            )
        `);
    }
}
