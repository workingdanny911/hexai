import { AsyncLocalStorage } from "node:async_hooks";
import _ from "lodash";
import { C } from "ts-toolbelt";

import {
    DuplicateObjectError,
    Entity,
    IdOf,
    ObjectNotFoundError,
    Repository,
} from "@/domain";
import { EventPublisher } from "@/application";
import {
    ConsumedMessageTracker,
    PublishedMessageTracker,
    UnitOfWork,
} from "@/infra";
import { Message } from "@/message";

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

type RepositoryEntityType<R extends Repository<any>> = R extends Repository<
    infer E
>
    ? E
    : never;

interface RepositoryConstructorArgs<R extends Repository<any>> {
    namespace: string;
    hydrate: (memento: any) => RepositoryEntityType<R>;
    dehydrate: (entity: RepositoryEntityType<R>) => unknown;
}

export default class InMemoryDatabaseConcerns implements UnitOfWork<void> {
    private state = emptyState();
    private transactionStore = new AsyncLocalStorage<State>();

    constructor() {
        this.clear();
    }

    public async wrap<TResult>(fn: () => Promise<TResult>): Promise<TResult> {
        const current = this.transactionStore.getStore();

        if (!current) {
            return this.wrapWithNew(fn);
        }

        try {
            return await fn();
        } catch (e) {
            current.transactionStatus = "closed";
            throw e;
        }
    }

    public async wrapWithNew<TResult>(
        fn: () => Promise<TResult>
    ): Promise<TResult> {
        const temporalState = _.cloneDeep(this.state);

        const result = await this.transactionStore.run(temporalState, fn);

        if (temporalState.transactionStatus === "open") {
            this.state = _.merge(this.state, temporalState);
        }

        return result;
    }

    public getClient(): void {
        return undefined;
    }

    public asUnitOfWork(): UnitOfWork<void> {
        return this;
    }

    public createRepository<R extends Repository<any>, M = any>(
        {
            namespace,
            hydrate,
            dehydrate,
        }: {
            namespace: string;
            hydrate: (memento: M) => RepositoryEntityType<R>;
            dehydrate: (entity: RepositoryEntityType<R>) => M;
        },
        clazz?: C.Class<[() => State, RepositoryConstructorArgs<R>], R>
    ): R {
        const getState = this.makeGetState(namespace);
        if (clazz) {
            return new clazz(getState, {
                namespace,
                hydrate,
                dehydrate,
            });
        }

        return new InMemoryRepository(getState, {
            namespace,
            hydrate,
            dehydrate,
        }) as any;
    }

    public createOutboxEventPublisher(): EventPublisher {
        return new InMemoryOutboxPublisher(this.makeGetState());
    }

    public createPublishedEventTracker(): PublishedMessageTracker {
        return new InMemoryPublishedEventTracker(this.makeGetState());
    }

    public createConsumedMessageTracker(): ConsumedMessageTracker {
        return new InMemoryConsumedMessageTracker(this.makeGetState());
    }

    private makeGetState(entityNamespace?: string): () => State {
        return () => {
            const state = this.transactionStore.getStore() || this.state;

            if (entityNamespace && !state[entityNamespace]) {
                state[entityNamespace] = {};
            }

            return new Proxy(state, {
                set: (target, property, value) => {
                    if (target.transactionStatus === "closed") {
                        throw new Error(
                            "transaction already closed, cannot mutate state"
                        );
                    }

                    (target as any)[property] = value;
                    return true;
                },
                get: (target, property) => {
                    if (property === "transactionStatus") {
                        return target.transactionStatus;
                    }

                    if (target.transactionStatus === "closed") {
                        throw new Error(
                            "transaction already closed, cannot mutate state"
                        );
                    }

                    return (target as any)[property];
                },
            });
        };
    }

    public clear(): void {
        this.state = emptyState();
    }
}

function emptyState(): State {
    return {
        transactionStatus: "open",
        events: [],
        unpublishedFrom: 1,
        consumedMessages: {},
    } as any;
}

export class InMemoryRepository<E extends Entity, M = any>
    implements Repository<E>
{
    protected namespace: string;
    protected hydrate: (memento: M) => E;
    protected dehydrate: (entity: E) => M;

    constructor(
        private getState: () => State,
        {
            hydrate,
            dehydrate,
            namespace,
        }: {
            namespace: string;
            hydrate: (memento: M) => E;
            dehydrate: (entity: E) => M;
        }
    ) {
        this.hydrate = hydrate;
        this.dehydrate = dehydrate;
        this.namespace = namespace;
    }

    public async add(entity: E): Promise<void> {
        const id = entity.getId().getValue();

        if (this.getEntities()[id]) {
            throw new DuplicateObjectError(
                `entity with id '${id}' already exists`
            );
        }

        this.save(entity);
    }

    public async update(entity: E): Promise<void> {
        const id = entity.getId().getValue();

        if (!this.getEntities()[id]) {
            throw new ObjectNotFoundError(`entity with id '${id}' not found`);
        }

        this.save(entity);
    }

    private save(entity: E): void {
        this.getEntities()[entity.getId().getValue()] = this.dehydrate(entity);
    }

    public async get(id: IdOf<E>): Promise<E> {
        const raw = this.getEntities()[id.getValue()];

        if (!raw) {
            throw new ObjectNotFoundError(
                `entity with id '${id.getValue()}' not found`
            );
        }

        return this.hydrate(raw);
    }

    public async count(): Promise<number> {
        return Object.keys(this.getEntities()).length;
    }

    protected getEntities(): Record<string, M> {
        return this.getState()[this.namespace] as any;
    }
}

class InMemoryOutboxPublisher implements EventPublisher {
    constructor(private getState: () => State) {}

    public async publish(...events: Message[]): Promise<void> {
        this.getState().events.push(...events);
    }
}

class InMemoryPublishedEventTracker implements PublishedMessageTracker {
    constructor(private getState: () => State) {}
    public async getUnpublishedMessages(
        batchSize?: number
    ): Promise<[number, Message[]]> {
        return [
            this.getState().unpublishedFrom,
            this.getState().events.slice(
                this.getState().unpublishedFrom - 1,
                batchSize
            ),
        ];
    }

    public async markMessagesAsPublished(
        fromPosition: number,
        numEvents: number
    ): Promise<void> {
        this.getState().unpublishedFrom = fromPosition + numEvents;
    }
}

class InMemoryConsumedMessageTracker implements ConsumedMessageTracker {
    constructor(private getState: () => State) {}

    public async markAsConsumed(name: string, event: Message): Promise<void> {
        if (!this.getState().consumedMessages[name]) {
            this.getState().consumedMessages[name] = new Set();
        }

        const eventSet = this.getState().consumedMessages[name];
        const eid = event.getMessageId();

        if (eventSet.has(eid)) {
            throw new Error(
                `Event '${event.getMessageId()}' is already consumed`
            );
        }

        eventSet.add(eid);
    }
}
