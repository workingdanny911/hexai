import { Database } from "sqlite";
import { Entity, IdOf, Repository } from "../../domain";
export declare class SqliteRepository<E extends Entity<any>, M> implements Repository<E> {
    protected db: Database;
    protected namespace: string;
    protected hydrate: (memento: M) => E;
    protected dehydrate: (entity: E) => M;
    constructor(db: Database, { namespace, hydrate, dehydrate, }: {
        namespace: string;
        hydrate: (memento: M) => E;
        dehydrate: (entity: E) => M;
    });
    get(id: IdOf<E>): Promise<E>;
    add(entity: E): Promise<void>;
    update(entity: E): Promise<void>;
    count(): Promise<number>;
    protected ensureTableExists(): Promise<void>;
}
//# sourceMappingURL=sqlite-repository.d.ts.map