"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.replaceDatabaseNameIn = exports.parseDatabaseNameFrom = void 0;
function parseDatabaseNameFrom(connectionString) {
    const match = connectionString.match(/\/([^/]+)$/);
    if (!match) {
        throw new Error("Invalid connection string");
    }
    return match[1];
}
exports.parseDatabaseNameFrom = parseDatabaseNameFrom;
function replaceDatabaseNameIn(connectionString, database) {
    return connectionString.replace(/\/([^/]+)$/, `/${database}`);
}
exports.replaceDatabaseNameIn = replaceDatabaseNameIn;
//# sourceMappingURL=database.js.map