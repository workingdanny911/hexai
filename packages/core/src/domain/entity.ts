export class EntityId<T extends string | number> {
    public constructor(private readonly value: T) {}

    public static from<T extends string | number>(value: T): EntityId<T> {
        return new (this as any)(value);
    }

    public getValue(): T {
        return this.value;
    }

    public equals(other: EntityId<T>): boolean {
        return (
            this.constructor === other.constructor &&
            this.getValue() === other.getValue()
        );
    }
}

export type IdOf<T> = T extends Entity<infer Id> ? Id : never;

export interface Entity<
    T extends EntityId<string | number> = EntityId<string>,
> {
    getId(): T;
}
