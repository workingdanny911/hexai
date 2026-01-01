import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { E2ETestContext, importGeneratedModule } from "../helpers";

describe("Runtime: Module Structure", () => {
    const ctx = new E2ETestContext("module-structure");

    beforeAll(async () => {
        await ctx.setup();
        await ctx.runParser();
    });

    afterAll(async () => {
        await ctx.teardown();
    });

    describe("SomeCommand", () => {
        it("should validate with valid foo/bar values", async () => {
            const { SomeCommand } = await importGeneratedModule<{
                SomeCommand: new (payload: Record<string, unknown>) => {
                    validate(): { foo: string; bar: string };
                };
            }>(ctx.getOutputFile("module-structure", "commands-but-different-filename.ts"));

            const cmd = new SomeCommand({
                foo: "hello",
                bar: "world",
            });

            const validated = cmd.validate();
            expect(validated.foo).toBe("hello");
            expect(validated.bar).toBe("world");
        });

        it("should throw when foo is null", async () => {
            const { SomeCommand } = await importGeneratedModule<{
                SomeCommand: new (payload: Record<string, unknown>) => {
                    validate(): unknown;
                };
            }>(ctx.getOutputFile("module-structure", "commands-but-different-filename.ts"));

            const cmd = new SomeCommand({
                foo: null,
                bar: "world",
            });

            expect(() => cmd.validate()).toThrow("foo is required");
        });

        it("should throw when bar is undefined", async () => {
            const { SomeCommand } = await importGeneratedModule<{
                SomeCommand: new (payload: Record<string, unknown>) => {
                    validate(): unknown;
                };
            }>(ctx.getOutputFile("module-structure", "commands-but-different-filename.ts"));

            const cmd = new SomeCommand({
                foo: "hello",
                bar: undefined,
            });

            expect(() => cmd.validate()).toThrow("bar is required");
        });

        it("should throw when foo is empty object", async () => {
            const { SomeCommand } = await importGeneratedModule<{
                SomeCommand: new (payload: Record<string, unknown>) => {
                    validate(): unknown;
                };
            }>(ctx.getOutputFile("module-structure", "commands-but-different-filename.ts"));

            const cmd = new SomeCommand({
                foo: {},
                bar: "world",
            });

            expect(() => cmd.validate()).toThrow("foo is required");
        });
    });

    describe("FooValidator", () => {
        it("should validate non-empty string", async () => {
            const { FooValidator } = await importGeneratedModule<{
                FooValidator: {
                    validateFoo(value: string): string;
                };
            }>(ctx.getOutputFile("module-structure", "foo.validator.ts"));

            const result = FooValidator.validateFoo("test");
            expect(result).toBe("test");
        });

        it("should throw on null value", async () => {
            const { FooValidator } = await importGeneratedModule<{
                FooValidator: {
                    validateFoo(value: unknown): unknown;
                };
            }>(ctx.getOutputFile("module-structure", "foo.validator.ts"));

            expect(() => FooValidator.validateFoo(null)).toThrow("foo is required");
        });

        it("should throw on undefined value", async () => {
            const { FooValidator } = await importGeneratedModule<{
                FooValidator: {
                    validateFoo(value: unknown): unknown;
                };
            }>(ctx.getOutputFile("module-structure", "foo.validator.ts"));

            expect(() => FooValidator.validateFoo(undefined)).toThrow(
                "foo is required"
            );
        });

        it("should throw on empty object", async () => {
            const { FooValidator } = await importGeneratedModule<{
                FooValidator: {
                    validateFoo(value: unknown): unknown;
                };
            }>(ctx.getOutputFile("module-structure", "foo.validator.ts"));

            expect(() => FooValidator.validateFoo({})).toThrow("foo is required");
        });
    });

    describe("validateBar function", () => {
        it("should validate non-empty string", async () => {
            const { validateBar } = await importGeneratedModule<{
                validateBar: (value: string) => string;
            }>(ctx.getOutputFile("module-structure", "bar.validator.ts"));

            const result = validateBar("test");
            expect(result).toBe("test");
        });

        it("should throw on null value", async () => {
            const { validateBar } = await importGeneratedModule<{
                validateBar: (value: unknown) => unknown;
            }>(ctx.getOutputFile("module-structure", "bar.validator.ts"));

            expect(() => validateBar(null)).toThrow("bar is required");
        });

        it("should throw on undefined value", async () => {
            const { validateBar } = await importGeneratedModule<{
                validateBar: (value: unknown) => unknown;
            }>(ctx.getOutputFile("module-structure", "bar.validator.ts"));

            expect(() => validateBar(undefined)).toThrow("bar is required");
        });
    });

    describe("isEmpty utility", () => {
        it("should return true for null", async () => {
            const { isEmpty } = await importGeneratedModule<{
                isEmpty: (value: unknown) => boolean;
            }>(ctx.getOutputFile("module-structure", "is-empty.ts"));

            expect(isEmpty(null)).toBe(true);
        });

        it("should return true for undefined", async () => {
            const { isEmpty } = await importGeneratedModule<{
                isEmpty: (value: unknown) => boolean;
            }>(ctx.getOutputFile("module-structure", "is-empty.ts"));

            expect(isEmpty(undefined)).toBe(true);
        });

        it("should return true for empty object", async () => {
            const { isEmpty } = await importGeneratedModule<{
                isEmpty: (value: unknown) => boolean;
            }>(ctx.getOutputFile("module-structure", "is-empty.ts"));

            expect(isEmpty({})).toBe(true);
        });

        it("should return false for non-empty values", async () => {
            const { isEmpty } = await importGeneratedModule<{
                isEmpty: (value: unknown) => boolean;
            }>(ctx.getOutputFile("module-structure", "is-empty.ts"));

            expect(isEmpty("hello")).toBe(false);
            expect(isEmpty(123)).toBe(false);
            expect(isEmpty({ key: "value" })).toBe(false);
        });
    });
});
