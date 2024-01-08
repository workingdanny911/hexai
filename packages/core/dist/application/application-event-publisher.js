"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApplicationEventPublisher = void 0;
const node_async_hooks_1 = require("node:async_hooks");
class ApplicationEventPublisher {
    callbacks = [];
    contextStorage = new node_async_hooks_1.AsyncLocalStorage();
    async bindContext(context, callback) {
        return await this.contextStorage.run(context, callback);
    }
    onPublish(callback) {
        if (this.callbacks.includes(callback)) {
            return;
        }
        this.callbacks.push(callback);
    }
    async publish(events) {
        for (const event of events) {
            await this.runCallbacks(event);
        }
    }
    async runCallbacks(event) {
        for (const callback of this.callbacks) {
            await callback(event, this.getCurrentContext());
        }
    }
    getCurrentContext() {
        return this.contextStorage.getStore() ?? null;
    }
}
exports.ApplicationEventPublisher = ApplicationEventPublisher;
//# sourceMappingURL=application-event-publisher.js.map