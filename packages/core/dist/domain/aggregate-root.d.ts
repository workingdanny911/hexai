import { Entity, EntityId } from "./entity";
import { DomainEvent } from "./domain-event";
export declare abstract class AggregateRoot<T extends EntityId<any>> implements Entity<T> {
    protected readonly id: T;
    protected events: Array<DomainEvent>;
    protected constructor(id: T);
    getId(): T;
    protected raise(event: DomainEvent<any>): void;
    collectEvents(): Array<DomainEvent>;
}
//# sourceMappingURL=aggregate-root.d.ts.map