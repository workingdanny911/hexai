import { AsyncLocalStorage } from "node:async_hooks";

import { EventPublisher } from "./event-publisher";

interface PublishCallback<E extends object, C extends object> {
    (event: E, context: C | null): void | Promise<void>;
}

export class ApplicationEventPublisher<
    E extends object = any,
    C extends object = any,
> implements EventPublisher<E>
{
    private callbacks: Array<PublishCallback<E, C>> = [];
    private contextStorage = new AsyncLocalStorage<C>();

    async bindContext<R>(context: C, callback: () => Promise<R>): Promise<R> {
        return await this.contextStorage.run(context, callback);
    }

    public onPublish(callback: PublishCallback<E, C>): void {
        if (this.callbacks.includes(callback)) {
            return;
        }

        this.callbacks.push(callback);
    }

    public async publish(events: E[]): Promise<void> {
        for (const event of events) {
            await this.runCallbacks(event);
        }
    }

    private async runCallbacks(event: E): Promise<void> {
        for (const callback of this.callbacks) {
            await callback(event, this.getCurrentContext());
        }
    }

    private getCurrentContext(): C | null {
        return this.contextStorage.getStore() ?? null;
    }
}

export type EventPublishingContextOf<P> = P extends ApplicationEventPublisher<
    any,
    infer C
>
    ? C
    : never;
