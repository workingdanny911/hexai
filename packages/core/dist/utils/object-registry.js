"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ObjectRegistry = exports.EntryNotFound = void 0;
const utils_1 = require("../utils");
class EntryNotFound extends Error {
    constructor(key) {
        super(`factory for '${String(key)}' not found.`);
    }
}
exports.EntryNotFound = EntryNotFound;
class ObjectRegistry {
    static EntryNotFound = EntryNotFound;
    registry = new Map();
    register(key, factory) {
        this.registry.set(key, factory);
    }
    isRegistered(key) {
        return this.registry.has(key);
    }
    keys() {
        return [...this.registry.keys()];
    }
    size() {
        return this.registry.size;
    }
    entries() {
        return [...this.registry.entries()];
    }
    createFrom(key, ...factoryArgs) {
        const factory = this.registry.get(key);
        if (!factory) {
            throw new EntryNotFound(`factory for '${String(key)}' not found.`);
        }
        if ((0, utils_1.isClass)(factory)) {
            return new factory(...factoryArgs);
        }
        else {
            return factory(...factoryArgs);
        }
    }
}
exports.ObjectRegistry = ObjectRegistry;
//# sourceMappingURL=object-registry.js.map