import { UnitOfWork } from "@/infra";
import { EventPublisher } from "@/event";

export interface UnitOfWorkHolder<U extends UnitOfWork = UnitOfWork> {
    getUnitOfWork(): U;
}

export interface EventPublisherHolder<
    E extends EventPublisher = EventPublisher,
> {
    getEventPublisher(): E;
}

export interface CommonApplicationContext<
    UoW extends UnitOfWork<any, any> = UnitOfWork,
    EPub extends EventPublisher = EventPublisher,
> extends UnitOfWorkHolder<UoW>,
        EventPublisherHolder<EPub> {}
