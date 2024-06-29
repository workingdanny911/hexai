import { beforeEach, describe, expect, test, vi } from "vitest";
import { waitForMs } from "@/utils";
import { DomainEvent } from "@/domain";
import { AsyncDomainEventPublisher } from "./async-domain-event-publisher";

class DummyDomainEvent extends DomainEvent {
    constructor() {
        super({});
    }
}

class Delegate {
    private callbacks: Array<(event: DomainEvent) => Promise<void>> = [];

    public async publish(event: DomainEvent): Promise<void> {
        await Promise.all(this.callbacks.map((callback) => callback(event)));
    }

    public register(callback: (event: DomainEvent) => Promise<void>): void {
        this.callbacks.push(callback);
    }
}

describe("domain event publisher", () => {
    let delegate: Delegate;
    let publisher: AsyncDomainEventPublisher;

    beforeEach(() => {
        vi.resetAllMocks();

        delegate = new Delegate();
        publisher = new AsyncDomainEventPublisher(delegate);
    });

    function newCallback(waitFor?: number) {
        let _done = false;
        const fn = vi.fn(async () => {
            if (waitFor) {
                await waitForMs(waitFor);
            }
            _done = true;
        });

        delegate.register(fn);

        return { fn, done: () => _done };
    }

    test("publishing", () => {
        const { fn } = newCallback();
        const event = new DummyDomainEvent();

        publisher.publish(event);

        expect(fn).toHaveBeenCalledOnce();
        expect(fn).toHaveBeenCalledWith(event);
    });

    test("waiting for completion of single callback", async () => {
        const cb = newCallback(100);

        publisher.publish(new DummyDomainEvent());
        expect(cb.done()).toBe(false);

        await publisher.waitForCompletion();
        expect(cb.done()).toBe(true);
    });

    test("waiting for completion of multiple callbacks", async () => {
        const cb1 = newCallback(50);
        const cb2 = newCallback(100);

        publisher.publish(new DummyDomainEvent());
        expect(cb1.done()).toBe(false);
        expect(cb2.done()).toBe(false);

        await publisher.waitForCompletion();
        expect(cb1.done()).toBe(true);
        expect(cb2.done()).toBe(true);
    });
});
