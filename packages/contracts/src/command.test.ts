import { expect, test } from "vitest";
import { Command } from "./command.js";

test("intent is 'command'", () => {
    expect(Command.getIntent()).toBe("command");
});
