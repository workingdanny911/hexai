export class EntityId<T extends string | number> {
    protected constructor(private readonly value: T) {}

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

export type IdTypeOf<T> = T extends Entity<infer R> ? R : never;

export default interface Entity<
    T extends EntityId<string | number> = EntityId<string>,
> {
    getId(): T;
}
