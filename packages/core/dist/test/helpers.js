"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrackableEventPublisher = void 0;
const application_1 = require("../application");
class TrackableEventPublisher extends application_1.ApplicationEventPublisher {
    events = [];
    getEventsPublished() {
        return this.events;
    }
    clear() {
        this.events = [];
    }
    async publish(events) {
        await super.publish(events);
        this.events.push(...events);
    }
}
exports.TrackableEventPublisher = TrackableEventPublisher;
//# sourceMappingURL=helpers.js.map