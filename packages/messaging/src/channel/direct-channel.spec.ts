import { beforeEach, describe, expect, test, vi } from "vitest";
import { DummyMessage } from "@hexai/core/test";

import { DirectChannel } from "./direct-channel";

describe("DirectChannel", () => {
    let channel: DirectChannel;
    const message = DummyMessage.create();

    beforeEach(() => {
        channel = new DirectChannel();
    });

    test("only one subscriber can subscribe to a direct channel", () => {
        const handler = async () => {};
        channel.subscribe(handler);

        expect(() => channel.subscribe(handler)).toThrowError(
            /only one subscriber/
        );
    });

    test("cannot send messages to the channel without a subscriber", async () => {
        await expect(channel.send(message)).rejects.toThrowError(
            /no subscriber/
        );
    });

    test("sends messages to the subscriber", async () => {
        const handler = vi.fn(async () => {});

        channel.subscribe(handler);
        await channel.send(message);

        expect(handler).toHaveBeenCalledWith(message);
    });

    test("waits for the subscriber to complete before returning", async () => {
        let handlerCompleted = false;
        const timeTakingHandler = async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            handlerCompleted = true;
        };

        channel.subscribe(timeTakingHandler);
        await channel.send(message);

        expect(handlerCompleted).toBe(true);
    });
});
