"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UnitOfWorkAbortedError = exports.IsolationLevel = exports.Propagation = void 0;
var Propagation;
(function (Propagation) {
    Propagation["NEW"] = "new";
    Propagation["EXISTING"] = "existing";
    Propagation["NESTED"] = "nested";
})(Propagation || (exports.Propagation = Propagation = {}));
var IsolationLevel;
(function (IsolationLevel) {
    IsolationLevel["READ_UNCOMMITTED"] = "read uncommitted";
    IsolationLevel["READ_COMMITTED"] = "read committed";
    IsolationLevel["REPEATABLE_READ"] = "repeatable read";
    IsolationLevel["SERIALIZABLE"] = "serializable";
})(IsolationLevel || (exports.IsolationLevel = IsolationLevel = {}));
class UnitOfWorkAbortedError extends Error {
}
exports.UnitOfWorkAbortedError = UnitOfWorkAbortedError;
//# sourceMappingURL=unit-of-work.js.map