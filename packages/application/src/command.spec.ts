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

    describe("withCorrelation", () => {
        it("should set correlation and return new instance", () => {
            const cmd1 = new TestCmd("hello");
            const cmd2 = cmd1.withCorrelation({ id: "corr-123", type: "HttpRequest" });

            expect(cmd1.getCorrelation()).toBeUndefined();
            expect(cmd2.getCorrelation()).toEqual({ id: "corr-123", type: "HttpRequest" });
        });

        it("should chain withCorrelation with withCausation", () => {
            const cmd = new TestCmd("hello")
                .withCorrelation({ id: "corr-123", type: "HttpRequest" })
                .withCausation({ id: "cause-456", type: "UserAction" });

            expect(cmd.getCorrelation()).toEqual({ id: "corr-123", type: "HttpRequest" });
            expect(cmd.getCausation()).toEqual({ id: "cause-456", type: "UserAction" });
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
