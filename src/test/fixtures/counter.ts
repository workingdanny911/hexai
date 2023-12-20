import {
    AggregateRoot,
    EntityId,
    ObjectNotFoundError,
    Repository,
} from "Hexai/domain";
import { Command, Event } from "Hexai/message";
import {
    ConsumedEventTracker,
    EventPublisher,
    EventTracker,
    UnitOfWork,
} from "Hexai/infra";
import {
    ErrorResponse,
    UseCase,
    validationErrorResponse,
} from "Hexai/application";
import InMemoryDatabaseConcerns from "./in-memory-database-concerns";

export class CounterId extends EntityId<string> {}

export interface CounterMemento {
    id: string;
    value: number;
}

export class Counter extends AggregateRoot<CounterId> {
    private value = 0;

    public static create(id: CounterId): Counter {
        const counter = new Counter(id);
        counter.raiseCreated();
        return counter;
    }

    private raiseCreated(): void {
        this.raise(new CounterCreated({ id: this.getId() }));
    }

    private constructor(id: CounterId, value?: number) {
        super(id);
        this.value = value ?? 0;
    }

    public increment(by = 1): void {
        this.value += by;

        this.raiseValueChange();
    }

    public decrement(by = 1): void {
        this.value -= by;

        this.raiseValueChange();
    }

    private raiseValueChange(): void {
        this.raise(
            new CounterValueChanged({ id: this.getId(), value: this.value })
        );
    }

    public static fromMemento(memento: CounterMemento): Counter {
        return new Counter(CounterId.from(memento.id), memento.value);
    }

    public toMemento(): CounterMemento {
        return {
            id: this.getId().getValue(),
            value: this.value,
        };
    }

    public getValue(): number {
        return this.value;
    }

    public equals(other: Counter): boolean {
        return (
            this.constructor === other.constructor &&
            this.getId().equals(other.getId()) &&
            this.getValue() === other.getValue()
        );
    }
}

export class CounterCreated extends Event<{
    id: CounterId;
}> {
    public static type = "test.counter.counter-created";

    public static deserializeRawPayload(rawPayload: { id: string }): unknown {
        return {
            id: CounterId.from(rawPayload.id),
        };
    }

    protected serializePayload(payload: {
        id: CounterId;
    }): Record<string, unknown> {
        return {
            id: payload.id.getValue(),
        };
    }
}

export class CounterValueChanged extends Event<{
    id: CounterId;
    value: number;
}> {
    public static type = "test.counter.counter-value-changed";

    public static deserializeRawPayload(rawPayload: {
        id: string;
        value: number;
    }): unknown {
        return {
            id: CounterId.from(rawPayload.id),
            value: rawPayload.value,
        };
    }

    protected serializePayload(payload: {
        id: CounterId;
        value: number;
    }): Record<string, unknown> {
        return {
            id: payload.id.getValue(),
            value: payload.value,
        };
    }
}

export interface CounterRepository extends Repository<Counter> {}

export class CounterApplicationContext {
    private static dbConcerns = new InMemoryDatabaseConcerns();
    private static unitOfWork = this.dbConcerns.asUnitOfWork();
    private static eventPublisher = this.dbConcerns.createEventPublisher();
    private static eventTracker = this.dbConcerns.createEventTracker();
    private static consumedEventTracker =
        this.dbConcerns.createConsumedEventTracker();
    private static counterRepository =
        this.dbConcerns.createRepository<CounterRepository>({
            namespace: "counter",
            hydrate: (memento) => Counter.fromMemento(memento),
            dehydrate: (entity) => entity.toMemento(),
        });

    public getUnitOfWork(): UnitOfWork {
        return CounterApplicationContext.unitOfWork;
    }

    public getEventPublisher(): EventPublisher {
        return CounterApplicationContext.eventPublisher;
    }

    public getEventTracker(): EventTracker {
        return CounterApplicationContext.eventTracker;
    }

    public getConsumedEventTracker(): ConsumedEventTracker {
        return CounterApplicationContext.consumedEventTracker;
    }

    public getCounterRepository(): CounterRepository {
        return CounterApplicationContext.counterRepository;
    }

    public static clear(): void {
        this.dbConcerns.clear();
    }
}

export class CreateCounterRequest extends Command {
    constructor(public readonly id: string) {
        super({
            id,
        });
    }
}
export class CreateCounter extends UseCase<
    CreateCounterRequest,
    void,
    CounterApplicationContext
> {
    public static readonly type = "test.counter.create-counter";

    public async doExecute(request: CreateCounterRequest): Promise<void> {
        const uow = this.getContext().getUnitOfWork();
        const repository = this.getContext().getCounterRepository();
        const eventPublisher = this.getContext().getEventPublisher();

        const counter = Counter.create(CounterId.from(request.id));

        await uow.wrap(async () => {
            await repository.add(counter);
            await eventPublisher.publish(counter.collectEvents());
        });
    }
}

export class IncreaseCounterRequest extends Command {
    constructor(public readonly id: string) {
        super({
            id,
        });
    }
}

export class IncreaseCounter extends UseCase<
    IncreaseCounterRequest,
    { value: number },
    CounterApplicationContext
> {
    public static readonly type = "test.counter.create-counter";

    public async doExecute(request: IncreaseCounterRequest): Promise<{
        value: number;
    }> {
        const uow = this.getContext().getUnitOfWork();
        const repository = this.getContext().getCounterRepository();
        const eventPublisher = this.getContext().getEventPublisher();

        return await uow.wrap(async () => {
            const counter = await repository.get(CounterId.from(request.id));

            counter.increment();

            await repository.update(counter);
            await eventPublisher.publish(counter.collectEvents());

            return {
                value: counter.getValue(),
            };
        });
    }

    static errorToResponse(error: Error): ErrorResponse | undefined {
        if (error instanceof ObjectNotFoundError) {
            return validationErrorResponse({
                id: "NOT_FOUND",
            });
        }
    }
}
