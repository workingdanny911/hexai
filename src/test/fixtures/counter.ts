import {
    AggregateRoot,
    EntityId,
    ObjectNotFoundError,
    Repository,
} from "Hexai/domain";
import { Command, Event } from "Hexai/message";
import {
    ConsumedEventTracker,
    OutboxEventPublisher,
    PublishedEventTracker,
    UnitOfWork,
} from "Hexai/infra";
import {
    Atomic,
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
    private static outboxEventPublisher =
        this.dbConcerns.createOutboxEventPublisher();
    private static publishedEventTracker =
        this.dbConcerns.createPublishedEventTracker();
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

    public getOutboxEventPublisher(): OutboxEventPublisher {
        return CounterApplicationContext.outboxEventPublisher;
    }

    public getPublishedEventTracker(): PublishedEventTracker {
        return CounterApplicationContext.publishedEventTracker;
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
    private readonly repository: CounterRepository;
    private readonly eventPublisher: OutboxEventPublisher;

    constructor(protected readonly context: CounterApplicationContext) {
        super(context);

        this.repository = context.getCounterRepository();
        this.eventPublisher = context.getOutboxEventPublisher();
    }

    @Atomic()
    public async doExecute(request: CreateCounterRequest): Promise<void> {
        const counter = Counter.create(CounterId.from(request.id));

        await this.repository.add(counter);
        await this.eventPublisher.publish(counter.collectEvents());
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
    private readonly repository: CounterRepository;
    private readonly eventPublisher: OutboxEventPublisher;

    constructor(protected readonly context: CounterApplicationContext) {
        super(context);

        this.repository = context.getCounterRepository();
        this.eventPublisher = context.getOutboxEventPublisher();
    }

    @Atomic()
    public async doExecute(request: IncreaseCounterRequest): Promise<{
        value: number;
    }> {
        const counter = await this.repository.get(CounterId.from(request.id));

        counter.increment();

        await this.repository.update(counter);
        await this.eventPublisher.publish(counter.collectEvents());

        return {
            value: counter.getValue(),
        };
    }

    static errorToResponse(error: Error): ErrorResponse | undefined {
        if (error instanceof ObjectNotFoundError) {
            return validationErrorResponse({
                id: "NOT_FOUND",
            });
        }
    }
}
