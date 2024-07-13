import {
    Atomic,
    ErrorResponse,
    UseCase,
    validationErrorResponse,
} from "@/application";
import { AggregateRoot, Id, ObjectNotFoundError, Repository } from "@/domain";
import { EventPublisher } from "@/event-publisher";
import { UnitOfWork } from "@/infra";
import { Message } from "@/message";
import { SqliteRepository } from "./sqlite";

export class CounterId extends Id<string> {}

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
        return new Counter(new CounterId(memento.id), memento.value);
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
            id: new CounterId(rawPayload.id),
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
            id: new CounterId(rawPayload.id),
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

abstract class CounterUseCase<Input, Output> extends UseCase<
    Input,
    Output,
    CounterApplicationContext
> {
    protected repository!: CounterRepository;

    public setApplicationContext(
        applicationContext: CounterApplicationContext
    ): void {
        super.setApplicationContext(applicationContext);

        this.repository = applicationContext.getCounterRepository();
    }
}

export class CreateCounter extends CounterUseCase<CreateCounterRequest, void> {
    @Atomic()
    public async doHandle(request: CreateCounterRequest): Promise<void> {
        const counter = Counter.create(new CounterId(request.id));

        await this.repository.add(counter);
        await this.eventPublisher.publish(...counter.getEventsOccurred());
    }
}

export class IncreaseCounterRequest extends Message {
    constructor(public readonly id: string) {
        super({
            id,
        });
    }
}

export class IncreaseCounter extends CounterUseCase<
    IncreaseCounterRequest,
    { value: number }
> {
    @Atomic()
    public async doHandle(request: IncreaseCounterRequest): Promise<{
        value: number;
    }> {
        const counter = await this.repository.get(new CounterId(request.id));

        counter.increment();

        await this.repository.update(counter);
        await this.eventPublisher.publish(...counter.getEventsOccurred());

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
