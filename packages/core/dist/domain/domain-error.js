"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ValidationError = exports.DomainError = void 0;
class DomainError extends Error {
}
exports.DomainError = DomainError;
class ValidationError extends DomainError {
    field;
    code;
    message;
    constructor(field, code, message = "") {
        super(message);
        this.field = field;
        this.code = code;
        this.message = message;
        this.name = "ValidationError";
    }
}
exports.ValidationError = ValidationError;
//# sourceMappingURL=domain-error.js.map