"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ObjectNotFoundError = exports.DuplicateObjectError = exports.RepositoryError = void 0;
class RepositoryError extends Error {
    constructor(message) {
        super(message);
        this.name = "RepositoryError";
    }
}
exports.RepositoryError = RepositoryError;
class DuplicateObjectError extends RepositoryError {
    constructor(message) {
        super(message);
        this.name = "DuplicateObjectError";
    }
}
exports.DuplicateObjectError = DuplicateObjectError;
class ObjectNotFoundError extends RepositoryError {
    constructor(message) {
        super(message);
        this.name = "ObjectNotFoundError";
    }
}
exports.ObjectNotFoundError = ObjectNotFoundError;
//# sourceMappingURL=repository.js.map