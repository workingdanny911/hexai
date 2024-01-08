"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.waitFor = exports.waitForMs = exports.waitForTicks = void 0;
async function waitForTicks(number = 10) {
    for (let i = 0; i < number; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}
exports.waitForTicks = waitForTicks;
async function waitForMs(number = 10) {
    await new Promise((resolve) => setTimeout(resolve, number));
}
exports.waitForMs = waitForMs;
async function waitFor(type = "ticks", number = 10) {
    if (type === "ticks") {
        await waitForTicks(number);
    }
    else {
        await waitForMs(number);
    }
}
exports.waitFor = waitFor;
//# sourceMappingURL=utils.js.map