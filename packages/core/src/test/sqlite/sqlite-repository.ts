import { Database } from "sqlite";

import {
    DuplicateObjectError,
    Entity,
    IdOf,
    ObjectNotFoundError,
    Repository,
} from "@/domain";

export class SqliteRepository<E extends Entity<any>, M>
    implements Repository<E>
{
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
        await this.ensureTableExists();

        const row = await this.db.get(
            `SELECT * FROM ${this.namespace} WHERE id = ?`,
            id.getValue()
        );
        if (!row) {
            throw new ObjectNotFoundError(
                `entity with id '${id.getValue()}' not found`
            );
        }

        return this.hydrate(JSON.parse(row.data));
    }

    async add(entity: E): Promise<void> {
        await this.ensureTableExists();

        try {
            await this.db.run(
                `INSERT INTO ${this.namespace} (id, data)
                 VALUES (?, ?)`,
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
        await this.ensureTableExists();

        const result = await this.db.run(
            `UPDATE ${this.namespace}
                 SET data = ?
                 WHERE id = ?`,
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
        await this.ensureTableExists();

        const result = await this.db.get(
            `SELECT COUNT(*) AS count FROM ${this.namespace}`
        );

        return result.count;
    }

    protected async ensureTableExists(): Promise<void> {
        await this.db.run(`
            CREATE TABLE IF NOT EXISTS ${this.namespace} (
                id TEXT NOT NULL PRIMARY KEY UNIQUE,
                data TEXT NOT NULL
            )
        `);
    }
}
