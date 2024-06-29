import { DomainEvent, DomainEventPublisher } from "@/domain";

export class AsyncDomainEventPublisher implements DomainEventPublisher {
    private callbackExecutions: Promise<void>[] = [];

    constructor(private delegate: DomainEventPublisher) {}

    public publish(event: DomainEvent): void {
        this.callbackExecutions.push(
            Promise.resolve(this.delegate.publish(event))
        );
    }

    public async waitForCompletion(): Promise<void> {
        await Promise.all(this.callbackExecutions);
    }
}
