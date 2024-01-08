"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isClass = void 0;
function isClass(obj) {
    return (typeof obj === "function" &&
        Object.hasOwn(obj, "prototype") &&
        Object.hasOwn(obj.prototype, "constructor"));
}
exports.isClass = isClass;
//# sourceMappingURL=inspection.js.map