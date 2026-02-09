import { AnyMessage, Message } from "@hexaijs/core";
import { EventPublisher } from "./event-publisher";

interface PublishCallback {
    (event: AnyMessage): void | Promise<void>;
}

export class ApplicationEventPublisher implements EventPublisher<Message> {
    private callbacks: Set<PublishCallback> = new Set();
    private context?: Message;

    public deriveFrom(message: Message): ApplicationEventPublisher {
        const derived = new ApplicationEventPublisher();
        derived.context = message;
        derived.callbacks = new Set(this.callbacks);

        return derived;
    }

    public subscribe(callback: PublishCallback): () => void {
        this.callbacks.add(callback);
        return () => this.unsubscribe(callback);
    }

    private unsubscribe(callback: PublishCallback): void {
        this.callbacks.delete(callback);
    }

    public async publish(...events: Message[]): Promise<void> {
        for (let event of events) {
            if (this.context) {
                const trace = this.context.asTrace();

                event = event
                    .withCausation(trace)
                    .withCorrelation(this.context.getCorrelation() ?? trace);
            }
            await this.runCallbacks(event);
        }
    }

    private async runCallbacks(event: Message): Promise<void> {
        await Promise.all([...this.callbacks].map((cb) => cb(event)));
    }
}
