import { UnitOfWork } from "@/infra";

export interface UnitOfWorkHolder<U extends UnitOfWork = UnitOfWork> {
    getUnitOfWork(): U;
}
