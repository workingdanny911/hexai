"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AbstractInjector = void 0;
class AbstractInjector {
    injectingObject;
    targets = [];
    addCandidate(candidate) {
        if (this.targets.includes(candidate)) {
            return;
        }
        if (this.isInjectable(candidate)) {
            this.targets.push(candidate);
        }
    }
    inject() {
        if (this.targets.length === 0) {
            return;
        }
        if (this.injectingObject === undefined) {
            throw new Error("Injecting object is not set. Use 'setInjectingObject' method to set it.");
        }
        this.targets.forEach((target) => this.doInject(target, this.injectingObject));
    }
    isInjectingObjectSet() {
        return !!this.injectingObject;
    }
    setInjectingObject(injectingObject) {
        this.injectingObject = injectingObject;
    }
}
exports.AbstractInjector = AbstractInjector;
//# sourceMappingURL=abstract-injector.js.map