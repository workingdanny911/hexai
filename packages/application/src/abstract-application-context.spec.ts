import { beforeEach, describe, expect, test, vi } from "vitest";

import { Message } from "@hexaijs/core";
import { DummyMessage } from "@hexaijs/core/test";
import { AbstractApplicationContext } from "./abstract-application-context";
import { Command } from "./command";

class ApplicationContextForTest extends AbstractApplicationContext {
    public events: Message[] = [];
    public onEnterMock = vi.fn();
    public onExitMock = vi.fn();

    constructor() {
        super();

        this.eventPublisher.subscribe((e) => {
            this.events.push(e);
        });
    }

    protected async onEnter(message: Message): Promise<void> {
        await super.onEnter(message);
        await this.onEnterMock(message);
    }

    protected async onExit(message: Message): Promise<void> {
        await super.onExit(message);
        await this.onExitMock(message);
    }
}

class TestCommand extends Command<{ value: string }> {
    constructor(value: string) {
        super({ value });
    }
}

describe("AbstractApplicationContext", () => {
    let context: ApplicationContextForTest;
    const command = new TestCommand("test");
    const event = DummyMessage.create();

    beforeEach(() => {
        context = new ApplicationContextForTest();
    });

    describe("publish", () => {
        test("delivers events to subscribers", async () => {
            await context.publish(event);

            expect(context.events).toContain(event);
        });
    });

    describe("enterCommandExecutionScope", () => {
        describe("function execution", () => {
            test("executes the provided function", async () => {
                const fn = vi.fn();

                await context.enterCommandExecutionScope(command, fn);

                expect(fn).toHaveBeenCalledTimes(1);
            });
        });

        describe("lifecycle hooks", () => {
            test("calls onEnter, fn, onExit in order", async () => {
                const callOrder: string[] = [];

                context.onEnterMock.mockImplementation(() =>
                    callOrder.push("onEnter")
                );
                context.onExitMock.mockImplementation(() =>
                    callOrder.push("onExit")
                );

                await context.enterCommandExecutionScope(command, async () => {
                    callOrder.push("fn");
                });

                expect(callOrder).toEqual(["onEnter", "fn", "onExit"]);
            });

            test("awaits onEnter before executing fn", async () => {
                let onEnterCompleted = false;
                let fnStartedAfterOnEnter = false;

                context.onEnterMock.mockImplementation(async () => {
                    await new Promise((r) => setTimeout(r, 10));
                    onEnterCompleted = true;
                });

                await context.enterCommandExecutionScope(command, async () => {
                    fnStartedAfterOnEnter = onEnterCompleted;
                });

                expect(fnStartedAfterOnEnter).toBe(true);
            });

            test("awaits fn before executing onExit", async () => {
                let fnCompleted = false;
                let onExitStartedAfterFn = false;

                context.onExitMock.mockImplementation(() => {
                    onExitStartedAfterFn = fnCompleted;
                });

                await context.enterCommandExecutionScope(command, async () => {
                    await new Promise((r) => setTimeout(r, 10));
                    fnCompleted = true;
                });

                expect(onExitStartedAfterFn).toBe(true);
            });

            test("passes command to onEnter and onExit", async () => {
                await context.enterCommandExecutionScope(command, async () => {
                    expect(context.onEnterMock).toHaveBeenCalledWith(command);
                    expect(context.onExitMock).not.toHaveBeenCalled();
                });

                expect(context.onExitMock).toHaveBeenCalledWith(command);
            });
        });

        describe("event publishing", () => {
            test("subscribers registered before scope receive events", async () => {
                await context.enterCommandExecutionScope(
                    command,
                    async (ctx) => {
                        await ctx.publish(event);
                    }
                );

                expect(context.events).toHaveLength(1);
            });

            test("sets correlation and causation from command", async () => {
                await context.enterCommandExecutionScope(
                    command,
                    async (ctx) => {
                        await ctx.publish(event);
                    }
                );

                const [publishedEvent] = context.events;
                expect(publishedEvent.getCorrelation()).toEqual(
                    command.asTrace()
                );
                expect(publishedEvent.getCausation()).toEqual(
                    command.asTrace()
                );
            });

            test("preserves existing correlation when command already has one", async () => {
                const root = DummyMessage.create();
                const commandWithCorrelation = command.withCorrelation(
                    root.asTrace()
                );

                await context.enterCommandExecutionScope(
                    commandWithCorrelation,
                    async (ctx) => {
                        await ctx.publish(event);
                    }
                );

                const [publishedEvent] = context.events;
                expect(publishedEvent.getCorrelation()).toEqual(
                    root.asTrace()
                );
                expect(publishedEvent.getCausation()).toEqual(
                    commandWithCorrelation.asTrace()
                );
            });
        });
    });
});
