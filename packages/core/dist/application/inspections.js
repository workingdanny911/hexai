"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isEventPublisherAware = exports.isUseCaseClass = exports.isApplicationContextAware = void 0;
const lodash_1 = __importDefault(require("lodash"));
const utils_1 = require("../utils");
const use_case_1 = require("./use-case");
function isApplicationContextAware(value) {
    return (lodash_1.default.isObject(value) &&
        typeof value.setApplicationContext === "function");
}
exports.isApplicationContextAware = isApplicationContextAware;
function isUseCaseClass(obj) {
    return (0, utils_1.isClass)(obj) && obj.prototype instanceof use_case_1.UseCase;
}
exports.isUseCaseClass = isUseCaseClass;
function isEventPublisherAware(value) {
    return (lodash_1.default.isObject(value) &&
        typeof value.setEventPublisher === "function");
}
exports.isEventPublisherAware = isEventPublisherAware;
//# sourceMappingURL=inspections.js.map