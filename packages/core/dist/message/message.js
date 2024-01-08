"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Message = void 0;
const uuid_1 = require("uuid");
class Message {
    payload;
    headers;
    static getSchemaVersion() {
        return this.schemaVersion ?? undefined;
    }
    static getType() {
        return this.type ?? this.name;
    }
    static newHeader() {
        return generateHeaderFor(this);
    }
    static from(rawPayload, headers) {
        const clazz = this;
        const payload = clazz.deserializeRawPayload(rawPayload);
        return new clazz(payload, headers);
    }
    static deserializeRawPayload(rawPayload) {
        return rawPayload;
    }
    constructor(payload, headers) {
        this.payload = payload;
        this.headers = headers ?? this.constructor.newHeader();
    }
    setHeader(field, value) {
        this.headers[field] = value;
    }
    getHeader(field) {
        return this.headers[field];
    }
    getPayload() {
        return this.payload;
    }
    getMessageId() {
        return this.headers.id;
    }
    getMessageType() {
        return this.getHeader("type");
    }
    getSchemaVersion() {
        return this.getHeader("schemaVersion");
    }
    getTimestamp() {
        return this.getHeader("createdAt");
    }
    serialize() {
        return {
            headers: { ...this.headers },
            payload: this.serializePayload(this.payload),
        };
    }
    serializePayload(payload) {
        return payload;
    }
}
exports.Message = Message;
function generateHeaderFor(cls) {
    return {
        id: (0, uuid_1.v4)(),
        type: cls.getType(),
        schemaVersion: cls.getSchemaVersion(),
        createdAt: new Date(),
    };
}
//# sourceMappingURL=message.js.map