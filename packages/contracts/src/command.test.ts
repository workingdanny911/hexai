import { expect, test } from "vitest";
import { Command } from "./command";

test("intent is 'command'", () => {
    expect(Command.getIntent()).toBe("command");
});
