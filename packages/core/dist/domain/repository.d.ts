import { Entity, IdOf } from "./entity";
export interface Repository<T extends Entity<any>> {
    get(id: IdOf<T>): Promise<T>;
    add(entity: T): Promise<void>;
    update(entity: T): Promise<void>;
    count(): Promise<number>;
}
export declare class RepositoryError extends Error {
    constructor(message: string);
}
export declare class DuplicateObjectError extends RepositoryError {
    constructor(message: string);
}
export declare class ObjectNotFoundError extends RepositoryError {
    constructor(message: string);
}
//# sourceMappingURL=repository.d.ts.map