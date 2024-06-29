export class Id<T extends string | number> {
    public constructor(private readonly value: T) {}

    public getValue(): T {
        return this.value;
    }

    public equals(other: Id<T>): boolean {
        return (
            this.constructor === other.constructor &&
            this.getValue() === other.getValue()
        );
    }
}

export type IdOf<T> = T extends Identifiable<infer Id> ? Id : never;

export interface Identifiable<T extends Id<string | number> = Id<string>> {
    getId(): T;
}
