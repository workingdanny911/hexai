import { AsyncLocalStorage } from "node:async_hooks";

import { EventPublisher } from "@/event-publisher";

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

    public onPublish(callback: PublishCallback<E, C>): () => void {
        const unsubscribe = () => this.unsubscribe(callback);

        if (!this.callbacks.includes(callback)) {
            this.callbacks.push(callback);
        }

        return unsubscribe;
    }

    private unsubscribe(callback: PublishCallback<E, C>): void {
        const index = this.callbacks.indexOf(callback);
        if (index === -1) {
            return;
        }

        this.callbacks.splice(index, 1);
    }

    public async publish(event: E): Promise<void> {
        await this.runCallbacks(event);
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
