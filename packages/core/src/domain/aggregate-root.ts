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

    protected raise(event: DomainEvent): void {
        this.events.push(event);
    }

    public getEventsOccurred(): DomainEvent[] {
        return [...this.events];
    }
}
