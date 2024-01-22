import {
    AggregateRoot,
    EntityId,
    ObjectNotFoundError,
    Repository,
} from "@/domain";
import {
    Atomic,
    ErrorResponse,
    EventPublisher,
    UseCase,
    validationErrorResponse,
} from "@/application";
import { Message } from "@/message";
import { UnitOfWork } from "@/infra";
import { SqliteRepository } from "./sqlite";

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

export class CounterCreated extends Message<{
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

export class CounterValueChanged extends Message<{
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

export class CreateCounterRequest extends Message {
    constructor(public readonly id: string) {
        super({
            id,
        });
    }
}

export interface CounterApplicationContext {
    getCounterRepository(): CounterRepository;
    getUnitOfWork(): UnitOfWork;
    getEventPublisher(): EventPublisher;
}

export class CreateCounter extends UseCase<
    CreateCounterRequest,
    void,
    CounterApplicationContext
> {
    @Atomic()
    public async doExecute(request: CreateCounterRequest): Promise<void> {
        const repository = this.applicationContext.getCounterRepository();

        const counter = Counter.create(CounterId.from(request.id));

        await repository.add(counter);
        await this.eventPublisher.publish(counter.collectEvents());
    }
}

export class IncreaseCounterRequest extends Message {
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
    @Atomic()
    public async doExecute(request: IncreaseCounterRequest): Promise<{
        value: number;
    }> {
        const repository = this.applicationContext.getCounterRepository();
        const counter = await repository.get(CounterId.from(request.id));

        counter.increment();

        await repository.update(counter);
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

export class SqliteCounterRepository
    extends SqliteRepository<Counter, CounterMemento>
    implements CounterRepository {}
