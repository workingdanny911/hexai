import { Event } from "@/message";
import Entity, { EntityId } from "./entity";

export default abstract class AggregateRoot<T extends EntityId<any>>
    implements Entity<T>
{
    protected events: Array<Event> = [];

    protected constructor(protected readonly id: T) {}

    public getId(): T {
        return this.id;
    }

    protected raise(event: Event<any>): void {
        this.events.push(event);
    }

    public collectEvents(): Array<Event> {
        const events = this.events;
        this.events = [];
        return events;
    }
}
