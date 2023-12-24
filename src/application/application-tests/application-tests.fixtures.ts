/* eslint-disable @typescript-eslint/no-unused-vars */
import { beforeEach, expect } from "vitest";
import { C } from "ts-toolbelt";

import {
    assertions,
    Counter,
    CounterApplicationContext,
    CounterCreated,
    CounterId,
    CreateCounter,
    CreateCounterRequest,
    IncreaseCounter,
    IncreaseCounterRequest,
} from "Hexai/test";
import { Command, Event, MessageClass } from "Hexai/message";
import { UnitOfWorkHolder } from "Hexai/helpers";
import { ApplicationBuilder, EventHandler, UseCase } from "Hexai/application";
import { OutboxEventPublisher } from "Hexai/infra";

export const counterApplicationContext = new CounterApplicationContext();

export const consumedEventTracker =
    counterApplicationContext.getConsumedEventTracker();
export const counterRepository =
    counterApplicationContext.getCounterRepository();

beforeEach(() => {
    CounterApplicationContext.clear();
    EchoEventHandler.clear();
});

export async function expectEventConsumed(
    handlerName: string,
    event: Event
): Promise<void> {
    await expect(
        consumedEventTracker.markAsConsumed(handlerName, event)
    ).rejects.toThrowError();
}

export async function expectEventNotConsumed(
    handlerName: string,
    event: Event
): Promise<void> {
    await assertions.expectEventNotConsumed(
        consumedEventTracker,
        handlerName,
        event
    );
}

interface UseCaseClassForTest<
    Name extends string,
    Ctx extends UnitOfWorkHolder,
    Req extends Command<{ [K in Name]: "request" }> = Command<{
        [K in Name]: "request";
    }>,
    Res extends { [K in Name]: "response" } = { [K in Name]: "response" },
> {
    new (ctx: Ctx): UseCase<Req, Res, Ctx>;
    Request: C.Class<[], Req>;
    Response: C.Class<[], Res>;
}

export function createDummyUseCaseClass<T extends string>(
    name: T
): UseCaseClassForTest<T, CounterApplicationContext> {
    class Request extends Command<{
        [K in T]: "request";
    }> {
        constructor() {
            super({
                [name]: "request",
            } as any);
        }
    }

    return class extends UseCase<
        Command<{ [K in T]: "request" }>,
        { [K in T]: "response" },
        CounterApplicationContext
    > {
        static Request = Request;

        static Response = class {
            constructor() {
                (this as any)[name] = "response";
            }
        } as C.Class<[], { [K in T]: "response" }>;

        protected async doExecute(request: Request): Promise<{
            [K in T]: "response";
        }> {
            return new (this.constructor as any).Response();
        }
    };
}

export const FooUseCase = createDummyUseCaseClass("Foo");
export const BarUseCase = createDummyUseCaseClass("Bar");
export const BazUseCase = createDummyUseCaseClass("Baz");
export const QuzUseCase = createDummyUseCaseClass("Quz");

export async function setUpCounter(id = "counter-id"): Promise<CounterCreated> {
    const counterId = CounterId.from(id);
    await counterRepository.add(Counter.create(counterId));
    return new CounterCreated({
        id: counterId,
    });
}

export class IncreaseValueWhenCounterCreated {
    constructor(private ctx: CounterApplicationContext) {}

    async handle(event: Event): Promise<void> {
        if (event instanceof CounterCreated) {
            await this.doHandle(event);
        }
    }

    async doHandle(event: CounterCreated): Promise<void> {
        await new IncreaseCounter(this.ctx).execute(
            new IncreaseCounterRequest(event.getPayload().id.getValue())
        );
    }
}

export function prepareCounterApplication(context: CounterApplicationContext) {
    return new ApplicationBuilder()
        .withContext(context)
        .withConsumedEventTracker(context.getConsumedEventTracker())
        .withUseCase(CreateCounterRequest, CreateCounter)
        .withUseCase(IncreaseCounterRequest, IncreaseCounter)
        .withIdempotentEventHandler(
            "increase",
            IncreaseValueWhenCounterCreated
        );
}

export class DummyEventHandler implements EventHandler {
    async handle(event: Event): Promise<void> {}
}

export class FailingEventHandler implements EventHandler {
    constructor(private ctx: CounterApplicationContext) {}

    async handle(event: Event): Promise<void> {
        await this.ctx.getUnitOfWork().wrap(() => {
            throw new Error("Something went wrong");
        });
    }
}

export class EchoEventHandler implements EventHandler {
    private static number = 0;

    public static clear() {
        this.number = 0;
    }

    private readonly eventPublisher: OutboxEventPublisher;

    constructor(
        private ctx: CounterApplicationContext,
        private number = 1
    ) {
        this.eventPublisher = ctx.getOutboxEventPublisher();
    }

    async handle(event: Event): Promise<void> {
        if (EchoEventHandler.number < this.number) {
            const messageClass = event.constructor as MessageClass;
            const { header, payload } = event.serialize();
            const newEvent = messageClass.from(payload, header) as Event;

            await this.eventPublisher.publish([newEvent]);

            EchoEventHandler.number++;
        }
    }
}
