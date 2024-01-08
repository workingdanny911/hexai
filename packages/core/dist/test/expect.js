"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setExpect = exports.expect = void 0;
const config_1 = require("../config");
if (config_1.RUNNING_HEXAI_TEST) {
    import("vitest").then(({ expect: expectStatic }) => {
        exports.expect = expectStatic;
    });
}
function setExpect(expectStatic) {
    exports.expect = expectStatic;
}
exports.setExpect = setExpect;
//# sourceMappingURL=expect.js.map