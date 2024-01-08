"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClassBasedCommandExecutorRegistry = void 0;
const utils_1 = require("../utils");
class ClassBasedCommandExecutorRegistry {
    handlers = new Map();
    register(key, executor) {
        if (!(0, utils_1.isClass)(key)) {
            throw new Error(`${key} is not a class`);
        }
        if (this.handlers.has(key)) {
            throw new Error("already registered");
        }
        this.handlers.set(key, executor);
    }
    get(command) {
        const commandClass = command.constructor;
        return this.handlers.get(commandClass) ?? null;
    }
}
exports.ClassBasedCommandExecutorRegistry = ClassBasedCommandExecutorRegistry;
//# sourceMappingURL=class-based-command-executor-registry.js.map