import { describe, expect, it } from "vitest";
import { Command } from "./command";

class TestCmd extends Command<{ value: string }> {
    constructor(value: string = "test") {
        super({ value });
    }
}

describe("Command", () => {
    describe("intent", () => {
        it("should have intent 'command' in headers", () => {
            const cmd = new TestCmd("hello");

            expect(cmd.getHeader("intent")).toBe("command");
        });

        it("should include intent in serialized output", () => {
            const cmd = new TestCmd("hello");
            const serialized = cmd.serialize();

            expect(serialized.headers.intent).toBe("command");
        });
    });

    describe("withHeader", () => {
        it("should set header and return new instance", () => {
            const cmd1 = new TestCmd("hello");
            const cmd2 = cmd1.withHeader("correlationId", "corr-123");

            expect(cmd1.getHeader("correlationId")).toBeUndefined();
            expect(cmd2.getHeader("correlationId")).toBe("corr-123");
        });

        it("should chain multiple withHeader calls", () => {
            const cmd = new TestCmd("hello")
                .withHeader("correlationId", "corr-123")
                .withHeader("correlationType", "HttpRequest");

            expect(cmd.getHeader("correlationId")).toBe("corr-123");
            expect(cmd.getHeader("correlationType")).toBe("HttpRequest");
        });
    });

    describe("withSecurityContext", () => {
        it("should set security context and return new instance", () => {
            const securityContext = { userId: "user-123", roles: ["admin"] };
            const cmd1 = new TestCmd("hello");

            const cmd2 = cmd1.withSecurityContext(securityContext);

            expect(() => cmd1.getSecurityContext()).toThrow(
                "security context is not set"
            );
            expect(cmd2.getSecurityContext()).toEqual(securityContext);
        });

        it("should chain withSecurityContext with withHeader", () => {
            const securityContext = { userId: "user-456" };

            const cmd = new TestCmd("hello")
                .withSecurityContext(securityContext)
                .withHeader("correlationId", "corr-789");

            expect(cmd.getSecurityContext()).toEqual(securityContext);
            expect(cmd.getHeader("correlationId")).toBe("corr-789");
        });
    });
});
