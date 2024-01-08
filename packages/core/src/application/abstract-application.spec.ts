import { beforeEach, describe, expect, it, Mock, test, vi } from "vitest";

import {
    expectAuthErrorResponse,
    expectSystemErrorResponse,
    expectValidationErrorResponse,
} from "@/test";
import { EventPublisher } from "./event-publisher";
import { ApplicationContextAware } from "./application-context-aware";
import { ApplicationEventPublisher } from "./application-event-publisher";
import { CommandExecutor } from "./command-executor";
import { CommandExecutorRegistry } from "./command-executor-registry";
import { Authenticator, AuthFilter } from "./auth";
import { AuthError } from "./error";
import { AbstractApplication } from "./abstract-application";
import { CommonApplicationContext } from "./application-context";

interface ApplicationEventContextForTest {
    trigger: object;
}

interface ApplicationContextForTest extends CommonApplicationContext {
    getEventPublisher(): ApplicationEventPublisher<
        object,
        ApplicationEventContextForTest
    >;
    getAuthenticator(): Authenticator<string, SecurityContextForTest>;
}

interface SecurityContextForTest {
    userId?: string;
}

class CommandExecutorRegistryForTest
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
    ApplicationContextForTest,
    object,
    SecurityContextForTest
> {
    constructor(
        context: ApplicationContextForTest,
        handlers: CommandExecutorRegistry<
            string,
            object
        > = new CommandExecutorRegistryForTest()
    ) {
        super(context, handlers);
    }

    protected makeEventContext(command: object) {
        return {
            trigger: command,
        };
    }
}

describe("Application", () => {
    let defaultApp: ApplicationForTest;
    let eventPublisher: ApplicationEventPublisher;
    let applicationContext: ApplicationContextForTest;

    const handler: CommandExecutor<any, any> = {
        execute: vi.fn(),
    };

    beforeEach(() => {
        eventPublisher = new ApplicationEventPublisher();
        applicationContext = {
            getEventPublisher: () => eventPublisher,
            getAuthenticator: vi.fn(),
            getUnitOfWork: vi.fn(),
        };
        defaultApp = makeApp();

        vi.resetAllMocks();
        vi.resetAllMocks();
    });

    function makeApp() {
        return new ApplicationForTest(applicationContext);
    }

    test("when no handler registered", async () => {
        const response = await defaultApp.execute({ type: "foo" });

        expectValidationErrorResponse(response, {
            "*": "UNSUPPORTED_MESSAGE_TYPE",
        });
    });

    it("handles messages", async () => {
        defaultApp.withExecutor("foo", handler);

        await defaultApp.execute({ type: "foo" });

        expect(handler.execute).toHaveBeenCalledWith({
            type: "foo",
        });
    });

    it("routes message to the correct handler", async () => {
        const handler2: CommandExecutor<any, any> = {
            execute: vi.fn(),
        };
        defaultApp.withExecutor("foo", handler).withExecutor("bar", handler2);

        await defaultApp.execute({ type: "bar" });

        expect(handler.execute).not.toHaveBeenCalled();
        expect(handler2.execute).toHaveBeenCalledWith({
            type: "bar",
        });
    });

    it("returns system error response when handler throws", async () => {
        (handler.execute as Mock).mockRejectedValue(new Error("handler error"));
        defaultApp.withExecutor("foo", handler);

        const response = await defaultApp.execute({ type: "foo" });

        expectSystemErrorResponse(response, "handler error");
    });

    test("handler errors can be observed", async () => {
        const onError = vi.fn();
        defaultApp.withExecutor("foo", handler);
        defaultApp.onError(onError);

        const error = new Error("handler error");
        (handler.execute as Mock).mockRejectedValue(error);

        await defaultApp.execute({ type: "foo" });

        expect(onError).toHaveBeenCalledWith({ type: "foo" }, error);
    });

    it("injects context to application context aware message handlers", async () => {
        const contextAwareHandler: CommandExecutor<any, any> &
            ApplicationContextAware = {
            execute: vi.fn(),
            setApplicationContext: vi.fn(),
        };
        defaultApp.withExecutor("some-message", contextAwareHandler);

        await defaultApp.execute({
            type: "some-message",
        });

        expect(contextAwareHandler.setApplicationContext).toHaveBeenCalledWith(
            applicationContext
        );
    });

    class EventPublishingHandler
        implements
            CommandExecutor<unknown, void>,
            ApplicationContextAware<ApplicationContextForTest>
    {
        private eventPublisher!: EventPublisher;

        async execute(): Promise<void> {
            await this.eventPublisher.publish([
                {
                    type: "published-event",
                },
            ]);
        }

        setApplicationContext(context: ApplicationContextForTest): void {
            this.eventPublisher = context.getEventPublisher();
        }
    }

    it("binds event context", async () => {
        const eventSubscriber = vi.fn();
        eventPublisher.onPublish(eventSubscriber);
        const trigger = {
            type: "trigger-message",
        };
        defaultApp.withExecutor(
            "trigger-message",
            new EventPublishingHandler()
        );

        await defaultApp.execute(trigger);

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
            defaultApp.withExecutor("auth-only", handler, { authFilter });
        });

        test("applying auth filter, but with no security context or auth factor", async () => {
            const response = await defaultApp.execute({ type: "auth-only" });

            expectAuthErrorResponse(response, /.*no authentication.*/);
        });

        test("applying auth filter with security context", async () => {
            const response = await defaultApp
                .withSecurityContext({
                    userId: "authenticated-user-id",
                })
                .execute({ type: "auth-only" });

            expect(response).toBeUndefined();
            expect(handler.execute).toHaveBeenCalled();
        });

        test("applying auth filter with auth factor", async () => {
            (applicationContext.getAuthenticator as Mock).mockReturnValue(
                authenticator
            );
            const response = await defaultApp
                .withAuthFactor("valid")
                .execute({ type: "auth-only" });

            expect(response).toBeUndefined();
            expect(handler.execute).toHaveBeenCalled();
        });
    });
});
