import { beforeEach, describe, expect, test } from "vitest";

import { CounterApplicationContext } from "Hexai/test";
import { ApplicationBuilder } from "Hexai/application";
import { consumedEventTracker, FooUseCase } from "./application-tests.fixtures";

const dummyEventHandlerFactory = (ctx: CounterApplicationContext) => ({
    handle: () => Promise.resolve(),
});

describe("application building constraints", () => {
    let builder: ApplicationBuilder;

    beforeEach(() => {
        builder = new ApplicationBuilder().withContext(
            CounterApplicationContext
        );
    });

    test("without context", () => {
        expect(() => new ApplicationBuilder().build()).toThrowError(
            /.*application context must be provided.*/i
        );
    });

    test("if no idempotent event handlers, consumed events tracker is not required", () => {
        expect(() =>
            builder.withEventHandler(dummyEventHandlerFactory).build()
        ).not.toThrowError();
    });

    test("with idempotent event handlers but without consumed events tracker", () => {
        expect(() =>
            builder
                .withIdempotentEventHandler(
                    "event-handler",
                    dummyEventHandlerFactory
                )
                .build()
        ).toThrowError(/.*consumed event tracker must be provided.*/i);
    });

    test("registering event handler with same name", () => {
        expect(() =>
            builder
                .withConsumedEventTracker(consumedEventTracker)
                .withEventHandler("event-handler", dummyEventHandlerFactory)
                .withEventHandler("event-handler", dummyEventHandlerFactory)
                .build()
        ).toThrowError(/.*already registered.*/);
    });

    test("registering idempotent event handler with same name", () => {
        expect(() =>
            builder
                .withConsumedEventTracker(consumedEventTracker)
                .withIdempotentEventHandler(
                    "event-handler",
                    dummyEventHandlerFactory
                )
                .withIdempotentEventHandler(
                    "event-handler",
                    dummyEventHandlerFactory
                )
                .build()
        ).toThrowError(/.*already registered.*/);
    });

    test.each([null, undefined, 1, "string", {}])(
        "requestClass must be a class - %s",
        async (invalidReqClass) => {
            expect(() => {
                // @ts-expect-error
                builder.withUseCase(invalidReqClass, {
                    execute: () => Promise.resolve(),
                });
            }).toThrowError(/.*must be a class.*/);
        }
    );

    test("when request class is duplicated", async () => {
        expect(() => {
            builder
                .withUseCase(FooUseCase.Request, FooUseCase)
                .withUseCase(FooUseCase.Request, FooUseCase);
        }).toThrowError(/.*already registered.*/);
    });
});
