import { Entity, EntityId } from "./entity";
import { DomainEvent } from "./domain-event";

export abstract class AggregateRoot<T extends EntityId<any>>
    implements Entity<T>
{
    protected events: Array<DomainEvent> = [];

    protected constructor(protected readonly id: T) {}

    public getId(): T {
        return this.id;
    }

    protected raise(event: DomainEvent<any>): void {
        this.events.push(event);
    }

    public collectEvents(): Array<DomainEvent> {
        return [...this.events];
    }
}
