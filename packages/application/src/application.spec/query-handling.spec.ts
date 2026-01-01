import { beforeEach, describe, expect, test, vi } from "vitest";
import { Message } from "@hexaijs/core";

import { AbstractApplicationContext } from "@/abstract-application-context";
import { Query } from "@/query";
import { ApplicationError, ApplicationErrorTransformingContext } from "@/error";
import { ApplicationBuilder, SuccessResult } from "@/application";
import { MessageHandler } from "@/message-handler";
import {
    DummyQuery,
    expectApplicationError,
    expectSuccessResult,
} from "@/test";

describe("Application, handling query", () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    const queryHandlerMock = {
        execute: vi.fn(),
    };

    class TestApplicationContext extends AbstractApplicationContext {
        public lastMessage: Message | null = null;

        protected async onEnter(message: Message): Promise<void> {
            await super.onEnter(message);
            this.lastMessage = message;
        }
    }

    let applicationContext: TestApplicationContext;

    let sutBuilder: ApplicationBuilder;
    const defaultSecurityContext = { role: "TEST" };
    const query = new DummyQuery("test-id", defaultSecurityContext);

    beforeEach(() => {
        applicationContext = new TestApplicationContext();
        sutBuilder = new ApplicationBuilder().withApplicationContext(
            applicationContext
        );
    });

    test.each([
        new SuccessResult({ foo: "bar" }),
        new SuccessResult({ foo: "baz" }),
    ])(
        "dispatches query to matching query handler",
        async (executionResult) => {
            queryHandlerMock.execute.mockResolvedValue(executionResult);
            const application = sutBuilder
                .withQueryHandler(DummyQuery, () => queryHandlerMock)
                .build();

            const result = await application.executeQuery(query);

            expectSuccessResult(result);
            expect(result.data).toBe(executionResult);
        }
    );

    test("enters message scope of the application context and injects it to the query handler", async () => {
        const queryHandlerSpy: {
            execute(
                request: Message,
                ctx?: TestApplicationContext
            ): Promise<string>;
        } = {
            async execute(request: any, ctx?: TestApplicationContext) {
                expect(ctx).toBeInstanceOf(TestApplicationContext);
                expect(ctx!.lastMessage).toBe(request);
                return "ok";
            },
        };

        const result = await sutBuilder
            .withQueryHandler(DummyQuery, () => queryHandlerSpy)
            .build()
            .executeQuery(query);

        expectSuccessResult(result);
        expect(result.data).toBe("ok");
    });

    test("if query handler class is registered, creates new query handler everytime before dispatching query", async () => {
        class QueryHandlerSpyWithId implements MessageHandler {
            static id = 0;
            private myId: number;

            constructor() {
                this.myId = ++QueryHandlerSpyWithId.id;
            }

            public async execute(
                query: DummyQuery,
                ctx?: TestApplicationContext
            ): Promise<string> {
                expect(ctx).toBeInstanceOf(TestApplicationContext);
                return `handled by ${this.myId}`;
            }
        }

        const sut = sutBuilder
            .withQueryHandler(DummyQuery, () => new QueryHandlerSpyWithId())
            .build();

        const handle = async () => {
            const result = await sut.executeQuery(new DummyQuery());
            expectSuccessResult(result);
            return result.data;
        };

        await expect(handle()).resolves.toBe("handled by 1");
        await expect(handle()).resolves.toBe("handled by 2");
    });

    test("without matching query handler, returns ApplicationError", async () => {
        const result = await sutBuilder.build().executeQuery(query);

        expectApplicationError(result);
    });

    test("transforms error thrown in query handler", async () => {
        const error = new Error("some error");
        queryHandlerMock.execute.mockRejectedValue(error);
        const application = sutBuilder
            .withErrorTransformer(
                (
                    error: Error,
                    context: ApplicationErrorTransformingContext
                ) => {
                    return new ApplicationError({
                        data: { error: "data" },
                        message: "message",
                        cause: error,
                    });
                }
            )
            .withQueryHandler(DummyQuery, () => queryHandlerMock)
            .build();

        const result = await application.executeQuery(query);

        expectApplicationError(result, {
            message: "message",
            cause: error,
        });
    });

    test("does not transform ApplicationError thrown in query handler", async () => {
        const originalError = new ApplicationError({
            message: "original query error",
            data: { originalData: "query value" },
        });
        queryHandlerMock.execute.mockRejectedValue(originalError);
        const errorTransformer = vi.fn();
        const application = sutBuilder
            .withErrorTransformer(errorTransformer)
            .withQueryHandler(DummyQuery, () => queryHandlerMock)
            .build();

        const result = await application.executeQuery(query);

        expect(errorTransformer).not.toHaveBeenCalled();
        expectApplicationError(result, {
            message: "original query error",
        });
    });
});
