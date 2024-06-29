import { beforeEach, describe, expect, it, Mock, test, vi } from "vitest";

import { UnitOfWork } from "@/infra";
import {
    expectSystemErrorResponse,
    expectValidationErrorResponse,
} from "@/test";
import { EventPublisher } from "@/event-publisher";
import { ApplicationContextAware } from "./application-context-aware";
import { ApplicationEventPublisher } from "./application-event-publisher";
import { CommandExecutor } from "./command-executor";
import { CommandExecutorRegistry } from "./command-executor-registry";
import { AbstractApplication } from "./abstract-application";
import { CommonApplicationContext } from "./application-context";
import { CommandExecutorRegistryForTest } from "./test-fixtures";

interface EventPublishingContextForTest {
    trigger: object;
}

interface ApplicationContextForTest
    extends CommonApplicationContext<
        UnitOfWork,
        ApplicationEventPublisher<object, EventPublishingContextForTest>
    > {}

class ApplicationForTest extends AbstractApplication<
    ApplicationContextForTest,
    object
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

    protected makeEventPublishingContext(
        command: object
    ): EventPublishingContextForTest {
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
            await this.eventPublisher.publish({
                type: "published-event",
            });
        }

        setApplicationContext(context: ApplicationContextForTest): void {
            this.eventPublisher = context.getEventPublisher();
        }
    }

    it("binds event publishing context", async () => {
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
});
