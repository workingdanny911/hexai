import { C, L } from "ts-toolbelt";

import { isClass } from "@/utils";

type Key = any;

type Factory<TArgs extends L.List = any[], TProduct extends object = object> =
    | C.Class<TArgs, TProduct>
    | ((...args: TArgs) => TProduct);

export class EntryNotFound extends Error {
    constructor(key: Key) {
        super(`factory for '${String(key)}' not found.`);
    }
}

export class ObjectRegistry<TKey = Key, TFactory extends Factory = Factory> {
    public static EntryNotFound = EntryNotFound;

    private readonly registry: Map<TKey, TFactory> = new Map();

    public register(key: TKey, factory: TFactory): void {
        this.registry.set(key, factory);
    }

    public isRegistered(key: TKey): boolean {
        return this.registry.has(key);
    }

    public keys(): Array<TKey> {
        return [...this.registry.keys()];
    }

    public size(): number {
        return this.registry.size;
    }

    public entries(): Array<[TKey, TFactory]> {
        return [...this.registry.entries()];
    }

    public createFrom<T>(key: TKey, ...factoryArgs: any[]): T {
        const factory = this.registry.get(key);
        if (!factory) {
            throw new EntryNotFound(`factory for '${String(key)}' not found.`);
        }

        if (isClass(factory)) {
            return new factory(...factoryArgs) as T;
        } else {
            return factory(...factoryArgs) as T;
        }
    }
}
