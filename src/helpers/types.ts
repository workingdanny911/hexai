import { UnitOfWork } from "Hexai/infra";

export interface UnitOfWorkHolder {
    getUnitOfWork(): UnitOfWork;
}