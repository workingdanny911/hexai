"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EntityId = void 0;
class EntityId {
    value;
    constructor(value) {
        this.value = value;
    }
    static from(value) {
        return new this(value);
    }
    getValue() {
        return this.value;
    }
    equals(other) {
        return (this.constructor === other.constructor &&
            this.getValue() === other.getValue());
    }
}
exports.EntityId = EntityId;
//# sourceMappingURL=entity.js.map