import { EventPublisher, UnitOfWork } from "Hexai/infra";

export interface BaseApplicationContext<
    UoW extends UnitOfWork<any, any> = UnitOfWork,
> {
    getUnitOfWork(): UoW;

    getEventPublisher(): EventPublisher;
}