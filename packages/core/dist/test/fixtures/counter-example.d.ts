import { AggregateRoot, EntityId, Repository } from "../../domain";
import { ErrorResponse, UseCase } from "../../application";
import { Message } from "../../message";
export declare class CounterId extends EntityId<string> {
}
export interface CounterMemento {
    id: string;
    value: number;
}
export declare class Counter extends AggregateRoot<CounterId> {
    private value;
    static create(id: CounterId): Counter;
    private raiseCreated;
    private constructor();
    increment(by?: number): void;
    decrement(by?: number): void;
    private raiseValueChange;
    static fromMemento(memento: CounterMemento): Counter;
    toMemento(): CounterMemento;
    getValue(): number;
    equals(other: Counter): boolean;
}
export declare class CounterCreated extends Message<{
    id: CounterId;
}> {
    static type: string;
    static deserializeRawPayload(rawPayload: {
        id: string;
    }): unknown;
    protected serializePayload(payload: {
        id: CounterId;
    }): Record<string, unknown>;
}
export declare class CounterValueChanged extends Message<{
    id: CounterId;
    value: number;
}> {
    static type: string;
    static deserializeRawPayload(rawPayload: {
        id: string;
        value: number;
    }): unknown;
    protected serializePayload(payload: {
        id: CounterId;
        value: number;
    }): Record<string, unknown>;
}
export interface CounterRepository extends Repository<Counter> {
}
export declare class CounterApplicationContext {
    private static dbConcerns;
    private static unitOfWork;
    private static outboxEventPublisher;
    private static publishedEventTracker;
    private static consumedEventTracker;
    private static counterRepository;
    getUnitOfWork(): import("../..").UnitOfWork<void, import("../..").CommonUnitOfWorkOptions>;
    getEventPublisher(): import("../../application").EventPublisher<object>;
    getPublishedEventTracker(): import("../..").PublishedMessageTracker;
    getConsumedEventTracker(): import("../..").ConsumedMessageTracker;
    getCounterRepository(): CounterRepository;
    static clear(): void;
}
export declare class CreateCounterRequest extends Message {
    readonly id: string;
    constructor(id: string);
}
export declare class CreateCounter extends UseCase<CreateCounterRequest, void, CounterApplicationContext> {
    doExecute(request: CreateCounterRequest): Promise<void>;
}
export declare class IncreaseCounterRequest extends Message {
    readonly id: string;
    constructor(id: string);
}
export declare class IncreaseCounter extends UseCase<IncreaseCounterRequest, {
    value: number;
}, CounterApplicationContext> {
    doExecute(request: IncreaseCounterRequest): Promise<{
        value: number;
    }>;
    static errorToResponse(error: Error): ErrorResponse | undefined;
}
//# sourceMappingURL=counter-example.d.ts.map