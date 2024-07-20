import { Event } from "./event";

interface Callback<E> {
    (event: E): void;
}

export class EventPublisher<E extends Event = Event> {
    private callbacks: Set<Callback<E>> = new Set();

    public subscribe(callback: Callback<E>): () => void {
        this.callbacks.add(callback);
        return () => this.unsubscribe(callback);
    }

    private unsubscribe(callback: Callback<E>): void {
        this.callbacks.delete(callback);
    }

    public async publish(...events: E[]): Promise<void> {
        for (const event of events) {
            await this.runCallbacks(event);
        }
    }

    private async runCallbacks(event: E): Promise<void> {
        for (const callback of this.callbacks) {
            await callback(event);
        }
    }
}
