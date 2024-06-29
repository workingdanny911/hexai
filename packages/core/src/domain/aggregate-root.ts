import { Identifiable, Id } from "./identifiable";
import { DomainEvent } from "./domain-event";
import { DomainEventPublisher } from "./domain-event-publisher";

class NullDomainEventPublisher implements DomainEventPublisher {
    public publish(event: DomainEvent): void {
        // do nothing
    }
}

const _nullDomainEventPublisher = new NullDomainEventPublisher();

export class AggregateRoot<T extends Id<string | number>>
    implements Identifiable<T>
{
    // dirty fix
    // i want the domain event publisher to be injected from outside
    // but couldn't find a way to do it yet
    protected domainEventPublisher: DomainEventPublisher =
        _nullDomainEventPublisher;
    private eventsBuffer: DomainEvent[] = [];

    constructor(protected readonly id: T) {}

    public getId(): T {
        return this.id;
    }

    protected raise(event: DomainEvent): void {
        if (this.isDomainEventPublisherSet()) {
            this.domainEventPublisher.publish(event);
        } else {
            this.eventsBuffer.push(event);
        }
    }

    private isDomainEventPublisherSet(): boolean {
        return this.domainEventPublisher !== _nullDomainEventPublisher;
    }

    public setDomainEventPublisher(
        domainEventPublisher: DomainEventPublisher
    ): void {
        this.domainEventPublisher = domainEventPublisher;

        if (this.isDomainEventPublisherSet()) {
            this.flushEventsBuffer();
        }
    }

    private flushEventsBuffer(): void {
        this.eventsBuffer.forEach((event) =>
            this.domainEventPublisher.publish(event)
        );
        this.eventsBuffer = [];
    }
}
