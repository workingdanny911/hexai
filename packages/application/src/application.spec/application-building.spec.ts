import { beforeEach, describe, expect, test, vi } from "vitest";

import { ApplicationBuilder } from "@/application";
import { CommandHandler } from "@/command-handler";
import { EventHandler } from "@/event-handler";
import { DummyCommand, DummyApplicationContext } from "@/test";

describe("ApplicationBuilder", () => {
    let sut: ApplicationBuilder;
    let dummyApplicationContext: DummyApplicationContext;

    beforeEach(() => {
        dummyApplicationContext = new DummyApplicationContext();
        sut = new ApplicationBuilder().withApplicationContext(
            dummyApplicationContext
        );
    });

    test("cannot build without application context", () => {
        expect(() => new ApplicationBuilder().build()).toThrow(
            /application context is required/i
        );
    });

    function createDummyCommandHandler(): CommandHandler {
        return {
            execute: vi.fn(),
        };
    }

    test("only one handler can be paired with a message", () => {
        sut.withCommandHandler(DummyCommand, () => createDummyCommandHandler());

        expect(() =>
            sut.withCommandHandler(DummyCommand, () =>
                createDummyCommandHandler()
            )
        ).toThrow(`'${DummyCommand.getType()}' is already paired with`);
    });

    test("when event handler name is given, only one event handler can be registered with that name", () => {
        const eventHandler: EventHandler = {
            handle: vi.fn(),
            canHandle: vi.fn(),
        };

        sut.withEventHandler(() => eventHandler, "event-handler-name");

        expect(() =>
            sut.withEventHandler(() => eventHandler, "event-handler-name")
        ).toThrow(
            "event handler with name 'event-handler-name' is already registered"
        );
    });
});
