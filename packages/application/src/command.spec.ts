import { describe, expect, expectTypeOf, it } from "vitest";
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

        it("should return typed security context with generic", () => {
            interface MySecurityContext {
                userId: string;
                roles: string[];
            }

            const sc: MySecurityContext = { userId: "u1", roles: ["admin"] };
            const cmd = new TestCmd("test").withSecurityContext(sc);

            const retrieved = cmd.getSecurityContext<MySecurityContext>();

            expect(retrieved.userId).toBe("u1");
            expect(retrieved.roles).toEqual(["admin"]);
            expectTypeOf(retrieved).toEqualTypeOf<MySecurityContext>();
        });
    });

    describe("ResultType indexed access", () => {
        it("extracts output type from Command", () => {
            class CreateUser extends Command<{ name: string }, { id: string }> {
                constructor(name: string) {
                    super({ name });
                }
            }

            type Output = CreateUser['ResultType'];

            expectTypeOf<Output>().toEqualTypeOf<{ id: string }>();
        });

        it("returns void for void output Command", () => {
            class DeleteUser extends Command<{ id: string }, void> {
                constructor(id: string) {
                    super({ id });
                }
            }

            type Output = DeleteUser['ResultType'];

            expectTypeOf<Output>().toEqualTypeOf<void>();
        });

        it("returns unknown for Command without explicit output", () => {
            class GenericCommand extends Command<{ data: string }> {
                constructor(data: string) {
                    super({ data });
                }
            }

            type Output = GenericCommand['ResultType'];

            expectTypeOf<Output>().toEqualTypeOf<unknown>();
        });

        it("works with complex output types", () => {
            interface UserData {
                id: string;
                profile: { name: string; age: number };
            }

            class GetUserData extends Command<{ userId: string }, UserData> {
                constructor(userId: string) {
                    super({ userId });
                }
            }

            type Output = GetUserData['ResultType'];

            expectTypeOf<Output>().toEqualTypeOf<UserData>();
        });
    });
});
