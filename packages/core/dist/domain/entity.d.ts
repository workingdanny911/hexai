export declare class EntityId<T extends string | number> {
    private readonly value;
    protected constructor(value: T);
    static from<T extends string | number>(value: T): EntityId<T>;
    getValue(): T;
    equals(other: EntityId<T>): boolean;
}
export type IdOf<T> = T extends Entity<infer Id> ? Id : never;
export interface Entity<T extends EntityId<string | number> = EntityId<string>> {
    getId(): T;
}
//# sourceMappingURL=entity.d.ts.map