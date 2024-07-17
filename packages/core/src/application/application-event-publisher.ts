import { AsyncLocalStorage } from "node:async_hooks";

import { EventPublisher } from "@/event-publisher";

interface PublishCallback<E, EPubCtx> {
    (event: E, context: EPubCtx | null): void | Promise<void>;
}

export class ApplicationEventPublisher<E = any, EPubCtx = any>
    implements EventPublisher<E>
{
    private callbacks: Set<PublishCallback<E, EPubCtx>> = new Set();
    private contextStorage = new AsyncLocalStorage<EPubCtx>();

    async withContext<R>(
        context: EPubCtx,
        callback: () => Promise<R>
    ): Promise<R> {
        return await this.contextStorage.run(context, callback);
    }

    public subscribe(callback: PublishCallback<E, EPubCtx>): () => void {
        this.callbacks.add(callback);
        return () => this.unsubscribe(callback);
    }

    private unsubscribe(callback: PublishCallback<E, EPubCtx>): void {
        this.callbacks.delete(callback);
    }

    public async publish(...events: E[]): Promise<void> {
        for (const event of events) {
            await this.runCallbacks(event);
        }
    }

    private async runCallbacks(event: E): Promise<void> {
        for (const callback of this.callbacks) {
            await callback(event, this.getCurrentContext());
        }
    }

    private getCurrentContext(): EPubCtx | null {
        return this.contextStorage.getStore() ?? null;
    }
}
