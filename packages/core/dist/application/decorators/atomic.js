"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Atomic = void 0;
function Atomic(options) {
    return function (target, propertyKey, descriptor) {
        if (typeof target.setApplicationContext !== "function") {
            throw new Error(`target '${target.constructor.name}' does not implement 'ApplicationContextAware'`);
        }
        let uow;
        const origSetApplicationContext = target.setApplicationContext;
        target.setApplicationContext = function (applicationContext) {
            origSetApplicationContext.call(this, applicationContext);
            uow = applicationContext.getUnitOfWork();
        };
        const originalMethod = descriptor.value;
        descriptor.value = async function (...args) {
            if (!uow) {
                throw new Error(`application context not injected to '${target.constructor.name}'`);
            }
            return await uow.wrap(async () => {
                return await originalMethod.apply(this, args);
            }, options);
        };
        return descriptor;
    };
}
exports.Atomic = Atomic;
//# sourceMappingURL=atomic.js.map