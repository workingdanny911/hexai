import { C } from "ts-toolbelt";
import { Entity, IdOf, Repository } from "../../domain";
import { EventPublisher } from "../../application";
import { ConsumedMessageTracker, PublishedMessageTracker, UnitOfWork } from "../../infra";
import { Message } from "../../message";
interface EntityStore {
    [entityNamespace: string]: Record<string | number, Entity>;
}
interface TransactionState {
    transactionStatus: "open" | "closed";
}
interface EventStore {
    events: Message[];
    unpublishedFrom: number;
    consumedMessages: Record<string, Set<string>>;
}
type State = EntityStore & EventStore & TransactionState;
type RepositoryEntityType<R extends Repository<any>> = R extends Repository<infer E> ? E : never;
interface RepositoryConstructorArgs<R extends Repository<any>> {
    namespace: string;
    hydrate: (memento: any) => RepositoryEntityType<R>;
    dehydrate: (entity: RepositoryEntityType<R>) => unknown;
}
export default class InMemoryDatabaseConcerns implements UnitOfWork<void> {
    private state;
    private transactionStore;
    constructor();
    wrap<TResult>(fn: () => Promise<TResult>): Promise<TResult>;
    wrapWithNew<TResult>(fn: () => Promise<TResult>): Promise<TResult>;
    getClient(): void;
    asUnitOfWork(): UnitOfWork<void>;
    createRepository<R extends Repository<any>, M = any>({ namespace, hydrate, dehydrate, }: {
        namespace: string;
        hydrate: (memento: M) => RepositoryEntityType<R>;
        dehydrate: (entity: RepositoryEntityType<R>) => M;
    }, clazz?: C.Class<[() => State, RepositoryConstructorArgs<R>], R>): R;
    createOutboxEventPublisher(): EventPublisher;
    createPublishedEventTracker(): PublishedMessageTracker;
    createConsumedMessageTracker(): ConsumedMessageTracker;
    private makeGetState;
    clear(): void;
}
export declare class InMemoryRepository<E extends Entity, M = any> implements Repository<E> {
    private getState;
    protected namespace: string;
    protected hydrate: (memento: M) => E;
    protected dehydrate: (entity: E) => M;
    constructor(getState: () => State, { hydrate, dehydrate, namespace, }: {
        namespace: string;
        hydrate: (memento: M) => E;
        dehydrate: (entity: E) => M;
    });
    add(entity: E): Promise<void>;
    update(entity: E): Promise<void>;
    private save;
    get(id: IdOf<E>): Promise<E>;
    count(): Promise<number>;
    protected getEntities(): Record<string, M>;
}
export {};
//# sourceMappingURL=in-memory-database-concerns.d.ts.map