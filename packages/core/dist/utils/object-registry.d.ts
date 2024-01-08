import { C, L } from "ts-toolbelt";
type Key = any;
type Factory<TArgs extends L.List = any[], TProduct extends object = object> = C.Class<TArgs, TProduct> | ((...args: TArgs) => TProduct);
export declare class EntryNotFound extends Error {
    constructor(key: Key);
}
export declare class ObjectRegistry<TKey = Key, TFactory extends Factory = Factory> {
    static EntryNotFound: typeof EntryNotFound;
    private readonly registry;
    register(key: TKey, factory: TFactory): void;
    isRegistered(key: TKey): boolean;
    keys(): Array<TKey>;
    size(): number;
    entries(): Array<[TKey, TFactory]>;
    createFrom<T>(key: TKey, ...factoryArgs: any[]): T;
}
export {};
//# sourceMappingURL=object-registry.d.ts.map