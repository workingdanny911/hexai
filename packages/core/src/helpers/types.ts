import { UnitOfWork } from "@/infra";

export interface UnitOfWorkAware<U extends UnitOfWork = UnitOfWork> {
    setUnitOfWork(uow: U): void;
}

export interface UnitOfWorkHolder<U extends UnitOfWork = UnitOfWork> {
    getUnitOfWork(): U;
}
