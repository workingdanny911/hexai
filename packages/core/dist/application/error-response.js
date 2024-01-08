"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authErrorResponse = exports.unknownErrorResponse = exports.systemErrorResponse = exports.validationErrorResponse = exports.isErrorResponse = void 0;
function isErrorResponse(response) {
    return (typeof response === "object" &&
        response !== null &&
        "errorType" in response);
}
exports.isErrorResponse = isErrorResponse;
function validationErrorResponse(fields) {
    return {
        errorType: "VALIDATION_ERROR",
        fields: Object.entries(fields).reduce((acc, [field, codeAndMessage]) => {
            const [code, message] = typeof codeAndMessage === "string"
                ? [codeAndMessage, undefined]
                : codeAndMessage;
            acc[field] = { code, message };
            return acc;
        }, {}),
    };
}
exports.validationErrorResponse = validationErrorResponse;
function systemErrorResponse(message, details) {
    return {
        errorType: "SYSTEM_ERROR",
        message,
        details,
    };
}
exports.systemErrorResponse = systemErrorResponse;
function unknownErrorResponse(message) {
    return {
        errorType: "UNKNOWN_ERROR",
        message,
    };
}
exports.unknownErrorResponse = unknownErrorResponse;
function authErrorResponse(message) {
    return {
        errorType: "AUTH_ERROR",
        message,
    };
}
exports.authErrorResponse = authErrorResponse;
//# sourceMappingURL=error-response.js.map