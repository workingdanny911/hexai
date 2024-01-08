"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApplicationContextInjector = void 0;
const application_1 = require("../application");
const abstract_injector_1 = require("./abstract-injector");
class ApplicationContextInjector extends abstract_injector_1.AbstractInjector {
    isInjectable(candidate) {
        return (0, application_1.isApplicationContextAware)(candidate);
    }
    doInject(target, injectingObject) {
        target.setApplicationContext(injectingObject);
    }
}
exports.ApplicationContextInjector = ApplicationContextInjector;
//# sourceMappingURL=application-context-injector.js.map