import { UnitOfWork } from "@/infra";

export interface CommonApplicationContext<
    UoW extends UnitOfWork<any, any> = UnitOfWork,
> {
    getUnitOfWork(): UoW;
}
