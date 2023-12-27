import { OutboxEventPublisher, UnitOfWork } from "@/infra";

export interface BaseApplicationContext<
    UoW extends UnitOfWork<any, any> = UnitOfWork,
> {
    getUnitOfWork(): UoW;

    getOutboxEventPublisher(): OutboxEventPublisher;
}
