"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DummyMessage = void 0;
const lodash_1 = __importDefault(require("lodash"));
const message_1 = require("../../message");
class DummyMessage extends message_1.Message {
    static type = "test.dummy-message";
    static create() {
        return new this({});
    }
    static createMany(number) {
        return lodash_1.default.times(number, () => this.create());
    }
    static from(_, headers) {
        return new this({}, headers);
    }
}
exports.DummyMessage = DummyMessage;
//# sourceMappingURL=dummy-message.js.map