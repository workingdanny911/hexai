"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AggregateRoot = void 0;
class AggregateRoot {
    id;
    events = [];
    constructor(id) {
        this.id = id;
    }
    getId() {
        return this.id;
    }
    raise(event) {
        this.events.push(event);
    }
    collectEvents() {
        return [...this.events];
    }
}
exports.AggregateRoot = AggregateRoot;
//# sourceMappingURL=aggregate-root.js.map