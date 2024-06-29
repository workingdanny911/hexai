import {
    AuthErrorResponse,
    SystemErrorResponse,
    UnknownErrorResponse,
    ValidationErrorResponse,
} from "@/application";
import { Message, MessageClass } from "@/message";

import { partialMatch } from "@/utils";
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
    expect(
        (response as T)?.errorType,
        `
        Expected response to be a ${errorType}, but it was not.
        Response: ${JSON.stringify(response, null, 2)}
        `
    ).toBe(errorType);
}

export function expectMessagesToBeFullyEqual(
    messages: Array<Message<any>>,
    expectedMessages: Array<Message<any>>
): void {
    expect(messages.length, "message length").toEqual(expectedMessages.length);

    for (let i = 0; i < messages.length; i++) {
        expect(messages[i].getMessageId(), `message[${i}] id`).toBe(
            expectedMessages[i].getMessageId()
        );
    }

    expectMessagesToBeEqual(messages, expectedMessages);
}

export function expectMessagesToBeEqual(
    messages: Array<Message<any>>,
    expectedMessages: Array<Message<any>>
): void {
    for (let i = 0; i < messages.length; i++) {
        expect(messages[i].getMessageType(), `message[${i}] type`).toBe(
            expectedMessages[i].getMessageType()
        );
        expect(
            messages[i].serialize().payload,
            `message[${i}] payload`
        ).toEqual(expectedMessages[i].serialize().payload);
    }
}

export function expectMessagesToContain(
    messages: Array<Message<any>>,
    expectedMessages: Array<Message<any>>
): void {
    for (const message of expectedMessages) {
        expectMessageToMatch(
            messages,
            message.getMessageType(),
            message.getPayload()
        );
    }
}

export function expectMessageToMatch(
    messages: Message[],
    messageType: string | MessageClass<any>,
    payload: Record<string, unknown> = {}
): void {
    const sameTypeOfEvents = messages.filter((event) => {
        if (typeof messageType === "string") {
            return event.getMessageType() === messageType;
        } else {
            return event.getMessageType() === messageType.getType();
        }
    });

    expect(
        sameTypeOfEvents,
        `Event not found: ${messageType}
${reprMessages(messages)}
`
    ).not.toHaveLength(0);

    const found = sameTypeOfEvents.find((event) =>
        partialMatch(event.getPayload(), payload)
    );

    expect(
        found,
        `Same type of events found, but payload did not match:
payload: ${JSON.stringify(payload, null, 2)}
events found: ${reprMessages(sameTypeOfEvents)}
`
    ).toBeTruthy();
}

function reprMessages(messages: Message[]): string {
    return JSON.stringify(
        messages.map((event) => event.getPayload()),
        null,
        2
    );
}
