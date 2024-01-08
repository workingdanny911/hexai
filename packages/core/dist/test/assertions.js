"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.expectMessagesToContain = exports.expectMessagesToEqual = exports.expectValidationErrorResponse = exports.expectUnknownErrorResponse = exports.expectSystemErrorResponse = exports.expectAuthErrorResponse = void 0;
const node_assert_1 = __importDefault(require("node:assert"));
const expect_1 = require("./expect");
function expectAuthErrorResponse(response, message) {
    assertIsErrorResponse(response, "AUTH_ERROR");
    if (message) {
        (0, expect_1.expect)(response.message).toMatch(message);
    }
}
exports.expectAuthErrorResponse = expectAuthErrorResponse;
function expectSystemErrorResponse(response, message) {
    assertIsErrorResponse(response, "SYSTEM_ERROR");
    if (message) {
        (0, expect_1.expect)(response.message).toMatch(message);
    }
}
exports.expectSystemErrorResponse = expectSystemErrorResponse;
function expectUnknownErrorResponse(response, message) {
    assertIsErrorResponse(response, "UNKNOWN_ERROR");
    if (message) {
        (0, expect_1.expect)(response.message).toMatch(message);
    }
}
exports.expectUnknownErrorResponse = expectUnknownErrorResponse;
function expectValidationErrorResponse(response, fields = {}) {
    assertIsErrorResponse(response, "VALIDATION_ERROR");
    for (const [fieldName, errorCode] of Object.entries(fields)) {
        if (errorCode === "*") {
            (0, expect_1.expect)(response.fields[fieldName]).toBeDefined();
        }
        else {
            (0, expect_1.expect)(response.fields[fieldName].code).toEqual(errorCode);
        }
    }
}
exports.expectValidationErrorResponse = expectValidationErrorResponse;
function assertIsErrorResponse(response, errorType) {
    (0, node_assert_1.default)(response?.errorType === errorType, `
        Expected response to be a ${errorType}, but it was not.
        Response: ${JSON.stringify(response, null, 2)}
        `);
}
function expectMessagesToEqual(messages, expectedMessages) {
    (0, expect_1.expect)(messages.map(serializeMessage)).toEqual(expectedMessages.map(serializeMessage));
}
exports.expectMessagesToEqual = expectMessagesToEqual;
function expectMessagesToContain(events, expectedEvents) {
    const target = events.map(serializeMessage);
    const expected = expectedEvents.map(serializeMessage);
    (0, expect_1.expect)(target).toEqual(expect_1.expect.arrayContaining(expected));
}
exports.expectMessagesToContain = expectMessagesToContain;
function serializeMessage(message) {
    return [
        message.getMessageType(),
        message.getSchemaVersion(),
        message.serialize().payload,
    ];
}
//# sourceMappingURL=assertions.js.map