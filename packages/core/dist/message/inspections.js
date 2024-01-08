"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isMessageClass = void 0;
const utils_1 = require("../utils");
const message_1 = require("./message");
function isMessageClass(value) {
    return (0, utils_1.isClass)(value) && value.prototype instanceof message_1.Message;
}
exports.isMessageClass = isMessageClass;
//# sourceMappingURL=inspections.js.map