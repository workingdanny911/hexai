import assert from "node:assert";

import {
    AuthErrorResponse,
    SystemErrorResponse,
    UnknownErrorResponse,
    ValidationErrorResponse,
} from "@/application";
import { Message } from "@/message";

import { expect } from "./expect";

export function expectAuthErrorResponse(
    response: unknown,
    message?: string | RegExp
): asserts response is AuthErrorResponse {
    assertIsErrorResponse<AuthErrorResponse>(response, "AUTH_ERROR");

    if (message) {
        expect((response as AuthErrorResponse).message).toMatch(message);
    }
}

export function expectSystemErrorResponse(
    response: unknown,
    message?: string | RegExp
): asserts response is SystemErrorResponse {
    assertIsErrorResponse<SystemErrorResponse>(response, "SYSTEM_ERROR");

    if (message) {
        expect((response as SystemErrorResponse).message).toMatch(message);
    }
}

export function expectUnknownErrorResponse(
    response: unknown,
    message?: string | RegExp
): asserts response is UnknownErrorResponse {
    assertIsErrorResponse<UnknownErrorResponse>(response, "UNKNOWN_ERROR");

    if (message) {
        expect((response as UnknownErrorResponse).message).toMatch(message);
    }
}

export function expectValidationErrorResponse(
    response: unknown,
    fields: Record<string, "*" | string> = {}
): asserts response is ValidationErrorResponse {
    assertIsErrorResponse<ValidationErrorResponse>(
        response,
        "VALIDATION_ERROR"
    );

    for (const [fieldName, errorCode] of Object.entries(fields)) {
        if (errorCode === "*") {
            expect(
                (response as ValidationErrorResponse).fields[fieldName]
            ).toBeDefined();
        } else {
            expect(
                (response as ValidationErrorResponse).fields[fieldName].code
            ).toEqual(errorCode);
        }
    }
}

function assertIsErrorResponse<T extends { errorType: string }>(
    response: unknown,
    errorType: string
): asserts response is T {
    assert(
        (response as T)?.errorType === errorType,
        `
        Expected response to be a ${errorType}, but it was not.
        Response: ${JSON.stringify(response, null, 2)}
        `
    );
}

export function expectMessagesToEqual(
    messages: Array<Message<any>>,
    expectedMessages: Array<Message<any>>
): void {
    expect(messages.map(serializeMessage)).toEqual(
        expectedMessages.map(serializeMessage)
    );
}

export function expectMessagesToContain(
    events: Array<Message<any>>,
    expectedEvents: Array<Message<any>>
): void {
    const target = events.map(serializeMessage);
    const expected = expectedEvents.map(serializeMessage);

    expect(target).toEqual(expect.arrayContaining(expected));
}

function serializeMessage(message: Message): unknown {
    return [
        message.getMessageType(),
        message.getSchemaVersion(),
        message.serialize().payload,
    ];
}
