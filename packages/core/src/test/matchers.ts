import _ from "lodash";

import { Message, MessageClass } from "@/message";
import { partialMatch } from "./utils";
import { expect } from "vitest";

export function expectMessagesToBeFullyEqual(
    messages: Message[],
    expectedMessages: Message[]
): void {
    const actualSummary = formatMessagesSummary(messages);
    const expectedSummary = formatMessagesSummary(expectedMessages);

    expect(actualSummary, "Messages should match").toEqual(expectedSummary);

    for (let i = 0; i < Math.max(messages.length, expectedMessages.length); i++) {
        const actual = messages[i]?.serialize();
        const expected = expectedMessages[i]?.serialize();

        expect(actual, `message[${i}]`).toEqual(expected);
    }
}

export function expectMessagesToContain(
    messages: Message[],
    expectedMessages: Message[]
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
    const resolvedMessageType =
        typeof messageType === "string" ? messageType : messageType.getType();
    const sameTypeMessages = messages.filter(
        (msg) => msg.getMessageType() === resolvedMessageType
    );

    if (sameTypeMessages.length === 0) {
        const availableTypes = [...new Set(messages.map((m) => m.getMessageType()))];
        expect.fail(
            `Message not found: "${resolvedMessageType}"\n\n` +
            `Available message types:\n` +
            (availableTypes.length === 0
                ? "  (none)"
                : availableTypes.map((t) => `  - ${t}`).join("\n"))
        );
    }

    const found = sameTypeMessages.find((msg) =>
        partialMatch(msg.getPayload(), payload)
    );

    if (!found) {
        const closestMatch = findClosestMatch(sameTypeMessages, payload);

        expect(
            closestMatch.payload,
            `Found ${sameTypeMessages.length} message(s) of type "${resolvedMessageType}", ` +
            `but payload did not match.\n` +
            `Showing closest match (${closestMatch.matchedKeys}/${closestMatch.totalKeys} keys matched):`
        ).toMatchObject(payload);
    }
}

function formatMessagesSummary(messages: Message[]): Array<{ type: string; payload: unknown }> {
    return messages.map((msg) => ({
        type: msg.getMessageType(),
        payload: msg.getPayload(),
    }));
}

function findClosestMatch(
    messages: Message[],
    expectedPayload: Record<string, unknown>
): { payload: Record<string, unknown>; matchedKeys: number; totalKeys: number } {
    const expectedKeys = Object.keys(expectedPayload);
    let bestMatch = {
        payload: messages[0]?.getPayload() ?? {},
        matchedKeys: 0,
        totalKeys: expectedKeys.length,
    };

    for (const msg of messages) {
        const actualPayload = msg.getPayload();
        const matchedKeys = countMatchedKeys(actualPayload, expectedPayload);

        if (matchedKeys > bestMatch.matchedKeys) {
            bestMatch = { payload: actualPayload, matchedKeys, totalKeys: expectedKeys.length };
        }
    }

    return bestMatch;
}

function countMatchedKeys(
    actual: Record<string, unknown>,
    expected: Record<string, unknown>
): number {
    let matched = 0;
    for (const key of Object.keys(expected)) {
        if (_.isEqual(actual[key], expected[key])) {
            matched++;
        }
    }
    return matched;
}
