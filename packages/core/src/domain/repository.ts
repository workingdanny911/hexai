import Entity, { IdTypeOf } from "./entity";

export default interface Repository<T extends Entity> {
    get(id: IdTypeOf<T>): Promise<T>;
    add(entity: T): Promise<void>;
    update(entity: T): Promise<void>;
    count(): Promise<number>;
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
