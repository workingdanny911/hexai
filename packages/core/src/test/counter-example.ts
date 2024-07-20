import { AggregateRoot, DomainEvent, Id, Repository } from "@/domain";
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
        counter.created();
        return counter;
    }

    private created(): void {
        this.raise<CounterCreated>("counter.created", {
            counterId: this.getId().getValue(),
        });
    }

    private constructor(id: CounterId, value?: number) {
        super(id);
        this.value = value ?? 0;
    }

    public increment(by = 1): void {
        this.value += by;

        this.valueChanged();
    }

    public decrement(by = 1): void {
        this.value -= by;

        this.valueChanged();
    }

    private valueChanged(): void {
        this.raise<CounterValueChanged>("counter.value-changed", {
            counterId: this.getId().getValue(),
            value: this.value,
        });
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

export type CounterCreated = DomainEvent<
    "counter.created",
    {
        counterId: string;
    }
>;

export type CounterValueChanged = DomainEvent<
    "counter.value-changed",
    {
        counterId: string;
        value: number;
    }
>;

export interface CounterRepository extends Repository<Counter> {}

export interface CreateCounterRequest {
    id: string;
}

export interface IncreaseCounterRequest {
    id: string;
}

export class SqliteCounterRepository
    extends SqliteRepository<Counter, CounterMemento>
    implements CounterRepository {}
