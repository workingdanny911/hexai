import assert from "node:assert";

import {
    AuthErrorResponse,
    SystemErrorResponse,
    UnknownErrorResponse,
    ValidationErrorResponse,
} from "@/application";
import { ConsumedEventTracker, PublishedEventTracker } from "@/infra";
import { Event } from "@/message";

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

export async function expectNoEventsPublished(
    eventTracker: PublishedEventTracker
): Promise<void> {
    await expect(eventTracker.getUnpublishedEvents()).resolves.toEqual([1, []]);
}

export async function expectEventsPublishedToEqual(
    eventTracker: PublishedEventTracker,
    expectedEvents: Array<Event<any>>
): Promise<void> {
    const [, unpublishedEvents] = await eventTracker.getUnpublishedEvents();
    expectEventsToEqual(unpublishedEvents, expectedEvents);
}

export async function expectEventsPublishedToContain(
    eventTracker: PublishedEventTracker,
    expectedEvents: Array<Event<any>>
): Promise<void> {
    const [, unpublishedEvents] = await eventTracker.getUnpublishedEvents();
    expectEventsToContain(unpublishedEvents, expectedEvents);
}

export function expectEventsToEqual(
    events: Array<Event<any>>,
    expectedEvents: Array<Event<any>>
): void {
    expect(events.map(serializeEvent)).toEqual(
        expectedEvents.map(serializeEvent)
    );
}

export function expectEventsToContain(
    events: Array<Event<any>>,
    expectedEvents: Array<Event<any>>
): void {
    const target = events.map(serializeEvent);
    const expected = expectedEvents.map(serializeEvent);

    expect(target).toEqual(expect.arrayContaining(expected));
}

function serializeEvent(event: Event): unknown {
    return [
        event.getMessageType(),
        event.getSchemaVersion(),
        event.serialize().payload,
    ];
}

export async function expectEventNotConsumed(
    consumedEventTracker: ConsumedEventTracker,
    eventHandlerName: string,
    event: Event
): Promise<void> {
    await expect(
        consumedEventTracker.markAsConsumed(eventHandlerName, event)
    ).resolves.toBeUndefined();
}
