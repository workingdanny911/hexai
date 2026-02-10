import { beforeEach, describe, expect, Mock, test, vi } from "vitest";

import { Message, MessageTrace } from "@hexaijs/core";
import { DummyMessage } from "@hexaijs/core/test";
import { ApplicationEventPublisher } from "./application-event-publisher";
import { ExecutionScope } from "./execution-scope";

class SecurityAwareEvent extends Message<null> {
    private securityContext?: { role: string };

    constructor(options?: { securityContext?: { role: string } }) {
        super(null);
        this.securityContext = options?.securityContext;
    }

    getSecurityContext(): { role: string } {
        if (!this.securityContext) {
            throw new Error("security context is not set");
        }

        return this.securityContext;
    }

    withSecurityContext(securityContext: { role: string }): this {
        const cloned = this.clone();
        cloned.securityContext = securityContext;
        return cloned;
    }
}

describe("application event publisher", () => {
    let publisher: ApplicationEventPublisher;
    let subscriber: Mock;
    const [event1, event2] = DummyMessage.createMany(2);

    beforeEach(() => {
        publisher = new ApplicationEventPublisher();
        subscriber = vi.fn();
    });

    test("subscribing", async () => {
        publisher.subscribe(subscriber);

        await publisher.publish(event1);
        await publisher.publish(event2);

        expect(subscriber.mock.calls).toEqual([[event1], [event2]]);
    });

    test("subscribing twice", async () => {
        publisher.subscribe(subscriber);
        publisher.subscribe(subscriber);

        await publisher.publish(event1);

        expect(subscriber).toHaveBeenCalledTimes(1);
    });

    async function wait(ms: number) {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }

    test("callbacks run event by event", async () => {
        publisher.subscribe(() => wait(50));

        const tStart = Date.now();
        await publisher.publish(event1);
        await publisher.publish(event2);
        const tEnd = Date.now();

        expect(tEnd - tStart).toBeGreaterThanOrEqual(50 * 2);
    });

    test("publishing fails when subscriber throws", async () => {
        publisher.subscribe(() => {
            throw new Error("test");
        });

        await expect(publisher.publish(event1)).rejects.toThrowError("test");
    });

    test("unsubscribing", async () => {
        const subscriber2 = vi.fn();

        const unsubscribe = publisher.subscribe(subscriber);
        publisher.subscribe(subscriber2);

        await publisher.publish(event1);

        unsubscribe();

        await publisher.publish(event2);

        expect(subscriber).toHaveBeenCalledTimes(1);
        expect(subscriber2).toHaveBeenCalledTimes(2);
    });

    test("publishing multiple events", async () => {
        publisher.subscribe(subscriber);

        await publisher.publish(event1, event2);

        expect(subscriber.mock.calls).toEqual([[event1], [event2]]);
    });

    function expectMetadata(
        event: Message,
        {
            correlation,
            causation,
        }: {
            correlation?: MessageTrace;
            causation?: MessageTrace;
        }
    ) {
        if (correlation) {
            expect(event.getCorrelation()).toEqual(correlation);
        }

        if (causation) {
            expect(event.getCausation()).toEqual(causation);
        }
    }

    test("publishes events without metadata when outside execution scope", async () => {
        subscriber.mockImplementation((event: Message) => {
            expect(event.getCorrelation()).toBeUndefined();
            expect(event.getCausation()).toBeUndefined();
        });
        publisher.subscribe(subscriber);

        await publisher.publish(event1);

        expect(subscriber).toBeCalled();
    });

    test("adds causation and falls back to causation as correlation when no correlation in scope", async () => {
        const command = DummyMessage.create();

        await ExecutionScope.run({ causation: command.asTrace() }, async () => {
            subscriber.mockImplementation((event: Message) => {
                const trace = command.asTrace();
                expectMetadata(event, {
                    causation: trace,
                    correlation: trace,
                });
            });
            publisher.subscribe(subscriber);

            await publisher.publish(event1);

            expect(subscriber).toBeCalled();
        });
    });

    test("uses correlation from execution scope when available", async () => {
        const root = DummyMessage.create();
        const child = DummyMessage.create();

        await ExecutionScope.run(
            { causation: child.asTrace(), correlation: root.asTrace() },
            async () => {
                subscriber.mockImplementation((event: Message) => {
                    expectMetadata(event, {
                        causation: child.asTrace(),
                        correlation: root.asTrace(),
                    });
                });
                publisher.subscribe(subscriber);

                await publisher.publish(event1);

                expect(subscriber).toBeCalled();
            }
        );
    });

    test("adds security context when execution scope has it", async () => {
        const securityContext = { role: "admin" };
        const event = new SecurityAwareEvent();
        let publishedEvent: SecurityAwareEvent | undefined;

        subscriber.mockImplementation((published: SecurityAwareEvent) => {
            publishedEvent = published;
        });
        publisher.subscribe(subscriber);

        await ExecutionScope.run({ securityContext }, async () => {
            await publisher.publish(event);
        });

        expect(() => event.getSecurityContext()).toThrow();
        expect(publishedEvent?.getSecurityContext()).toEqual(securityContext);
    });

    test("same publisher instance works across different scopes", async () => {
        publisher.subscribe(subscriber);

        const command1 = DummyMessage.create();
        const command2 = DummyMessage.create();

        await ExecutionScope.run({ causation: command1.asTrace() }, async () => {
            await publisher.publish(event1);
        });

        await ExecutionScope.run({ causation: command2.asTrace() }, async () => {
            await publisher.publish(event2);
        });

        expect(subscriber).toHaveBeenCalledTimes(2);

        const publishedEvent1 = subscriber.mock.calls[0][0] as Message;
        const publishedEvent2 = subscriber.mock.calls[1][0] as Message;

        expect(publishedEvent1.getCausation()).toEqual(command1.asTrace());
        expect(publishedEvent2.getCausation()).toEqual(command2.asTrace());
    });
});
