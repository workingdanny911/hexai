import { UnitOfWork } from "@/infra";

export interface UnitOfWorkHolder {
    getUnitOfWork(): UnitOfWork;
}
