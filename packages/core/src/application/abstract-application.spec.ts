import { beforeEach, describe, expect, it, Mock, test, vi } from "vitest";

import {
    expectAuthErrorResponse,
    expectSystemErrorResponse,
    expectValidationErrorResponse,
} from "@/test";
import { EventPublisher } from "./event-publisher";
import { EventPublisherAware } from "./event-publisher-aware";
import { ApplicationContextAware } from "./application-context-aware";
import { CommonApplicationContext } from "./common-application-context";
import { ApplicationEventPublisher } from "./application-event-publisher";
import { CommandExecutor } from "./command-executor";
import { CommandExecutorRegistry } from "./command-executor-registry";
import { Authenticator, AuthFilter } from "./auth";
import { AuthError } from "./error";
import { AbstractApplication } from "./abstract-application";

interface ApplicationEventContextForTest {
    trigger: object;
}

interface SecurityContextForTest {
    userId?: string;
}

class MessageHandlerRegistryForTest
    implements CommandExecutorRegistry<string, object>
{
    private handlers: Record<string, CommandExecutor<object, any>> = {};

    register(key: string, handler: CommandExecutor<object, any>): void {
        if (this.handlers[key]) {
            throw new Error("already registered");
        }

        this.handlers[key] = handler;
    }

    get(message: object): CommandExecutor<object, any> | null {
        return this.handlers[(message as any).type] ?? null;
    }
}

class ApplicationForTest extends AbstractApplication<
    CommonApplicationContext,
    ApplicationEventPublisher<object, ApplicationEventContextForTest>,
    any,
    SecurityContextForTest
> {
    constructor(
        context: CommonApplicationContext,
        eventPublisher: ApplicationEventPublisher<
            object,
            ApplicationEventContextForTest
        >,
        handlers: CommandExecutorRegistry<
            string,
            object
        > = new MessageHandlerRegistryForTest()
    ) {
        super(context, eventPublisher, handlers);
    }

    protected makeEventContext(
        message: object
    ): ApplicationEventContextForTest {
        return {
            trigger: message,
        };
    }
}

describe("Application", () => {
    let defaultApp: ApplicationForTest;
    const applicationContext: CommonApplicationContext = {
        getUnitOfWork: vi.fn(),
    };
    let eventPublisher: ApplicationEventPublisher<
        object,
        ApplicationEventContextForTest
    >;

    const handler: CommandExecutor<any, any> = {
        execute: vi.fn(),
    };

    beforeEach(() => {
        eventPublisher = new ApplicationEventPublisher();
        defaultApp = makeApp();

        vi.resetAllMocks();
    });

    function makeApp() {
        return new ApplicationForTest(applicationContext, eventPublisher);
    }

    test("when no handler registered", async () => {
        const response = await defaultApp.handle({ type: "foo" });

        expectValidationErrorResponse(response, {
            "*": "UNSUPPORTED_MESSAGE_TYPE",
        });
    });

    it("handles messages", async () => {
        defaultApp.withHandler("foo", handler);

        await defaultApp.handle({ type: "foo" });

        expect(handler.execute).toHaveBeenCalledWith({
            type: "foo",
        });
    });

    it("routes message to the correct handler", async () => {
        const handler2: CommandExecutor<any, any> = {
            execute: vi.fn(),
        };
        defaultApp.withHandler("foo", handler).withHandler("bar", handler2);

        await defaultApp.handle({ type: "bar" });

        expect(handler.execute).not.toHaveBeenCalled();
        expect(handler2.execute).toHaveBeenCalledWith({
            type: "bar",
        });
    });

    it("returns system error response when handler throws", async () => {
        (handler.execute as Mock).mockRejectedValue(new Error("handler error"));
        defaultApp.withHandler("foo", handler);

        const response = await defaultApp.handle({ type: "foo" });

        expectSystemErrorResponse(response, "handler error");
    });

    it("injects context to application context aware message handlers", async () => {
        const contextAwareHandler: CommandExecutor<any, any> &
            ApplicationContextAware = {
            execute: vi.fn(),
            setApplicationContext: vi.fn(),
        };
        defaultApp.withHandler("some-message", contextAwareHandler);

        await defaultApp.handle({
            type: "some-message",
        });

        expect(contextAwareHandler.setApplicationContext).toHaveBeenCalledWith(
            applicationContext
        );
    });

    it("injects event publisher to message handlers", async () => {
        const eventPublisherAwareHandler: CommandExecutor<any, any> &
            EventPublisherAware = {
            execute: vi.fn(),
            setEventPublisher: vi.fn(),
        };
        defaultApp.withHandler("some-message", eventPublisherAwareHandler);

        await defaultApp.handle({
            type: "some-message",
        });

        expect(
            eventPublisherAwareHandler.setEventPublisher
        ).toHaveBeenCalledWith(eventPublisher);
    });

    class EventPublishingHandler
        implements CommandExecutor<unknown, void>, EventPublisherAware
    {
        private eventPublisher!: EventPublisher;

        async execute(): Promise<void> {
            await this.eventPublisher.publish({
                type: "published-event",
            });
        }

        setEventPublisher(publisher: EventPublisher): void {
            this.eventPublisher = publisher;
        }
    }

    it("binds event context", async () => {
        const eventSubscriber = vi.fn();
        eventPublisher.onPublish(eventSubscriber);
        const trigger = {
            type: "trigger-message",
        };
        defaultApp.withHandler("trigger-message", new EventPublishingHandler());

        await defaultApp.handle(trigger);

        expect(eventSubscriber).toHaveBeenCalledWith(
            { type: "published-event" },
            {
                trigger,
            }
        );
    });

    describe("authentication", () => {
        const authFilter: AuthFilter<SecurityContextForTest, any> = (
            ctx,
            message
        ) => {
            if (!ctx.userId) {
                throw new Error("unauthenticated");
            }
        };

        const authenticator: Authenticator<string, SecurityContextForTest> = (
            factor
        ) => {
            if (factor === "valid") {
                return {
                    userId: "user-id",
                };
            }

            throw new AuthError("invalid factor");
        };

        beforeEach(() => {
            defaultApp
                .withAuthenticator(authenticator)
                .withHandler("auth-only", handler, { authFilter });
        });

        test("applying auth filter, but with no security context or auth factor", async () => {
            const response = await defaultApp.handle({ type: "auth-only" });

            expectAuthErrorResponse(response, /.*no authentication.*/);
        });

        test("applying auth filter with security context", async () => {
            const response = await defaultApp
                .withSecurityContext({
                    userId: "authenticated-user-id",
                })
                .handle({ type: "auth-only" });

            expect(response).toBeUndefined();
            expect(handler.execute).toHaveBeenCalled();
        });

        test("applying auth filter with auth factor", async () => {
            const response = await defaultApp
                .withAuthFactor("valid")
                .handle({ type: "auth-only" });

            expect(response).toBeUndefined();
            expect(handler.execute).toHaveBeenCalled();
        });
    });
});
