"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageRegistry = void 0;
const utils_1 = require("../utils");
class MessageRegistry {
    registry = new utils_1.ObjectRegistry();
    register(messageClass) {
        const type = messageClass.getType();
        const version = messageClass.getSchemaVersion();
        const key = makeKey(type, version);
        if (this.registry.isRegistered(key)) {
            throw new Error(`${format(type, version)} is already registered.`);
        }
        // @ts-expect-error: to use spread operator
        const factory = (...args) => messageClass.from(...args);
        this.registry.register(key, factory);
    }
    dehydrate(header, body) {
        const { type, schemaVersion } = header;
        const key = makeKey(type, schemaVersion);
        if (!this.registry.isRegistered(key)) {
            throw new Error(`${format(type, schemaVersion)} is not registered.`);
        }
        return this.registry.createFrom(key, body, header);
    }
}
exports.MessageRegistry = MessageRegistry;
function makeKey(type, version) {
    const versionPart = version ? `:${version}` : "";
    return `event:${type}${versionPart}`;
}
function format(type, version) {
    return `'${type}'${version ? ` with version '${version}'` : ""}`;
}
//# sourceMappingURL=message-registry.js.map