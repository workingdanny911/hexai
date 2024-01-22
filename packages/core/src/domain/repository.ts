import { Entity, IdOf } from "./entity";

export interface Repository<T extends Entity<any>> {
    get(id: IdOf<T>): Promise<T>;
    add(entity: T): Promise<void>;
    update(entity: T): Promise<void>;
}

export class RepositoryError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RepositoryError";
    }
}

export class DuplicateObjectError extends RepositoryError {
    constructor(message: string) {
        super(message);
        this.name = "DuplicateObjectError";
    }
}

export class ObjectNotFoundError extends RepositoryError {
    constructor(message: string) {
        super(message);
        this.name = "ObjectNotFoundError";
    }
}
