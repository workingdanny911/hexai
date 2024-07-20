import { DomainEvent } from "./domain-event";
import { Id, Identifiable } from "./identifiable";

export class AggregateRoot<T extends Id<string | number>>
    implements Identifiable<T>
{
    protected events: DomainEvent[] = [];

    constructor(protected readonly id: T) {}

    public getId(): T {
        return this.id;
    }

    protected raise<E extends DomainEvent>(
        type: E["type"],
        payload: E["payload"]
    ): void {
        this.events.push({
            type,
            payload,
            occurredAt: new Date(),
        });
    }

    public getEventsOccurred(): DomainEvent[] {
        return [...this.events];
    }
}
