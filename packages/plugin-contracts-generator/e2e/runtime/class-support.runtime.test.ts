import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { E2ETestContext, importGeneratedModule } from "../helpers";
import type { ProcessContextResult } from "../../src/index";

describe("Runtime: Class Support", () => {
    const ctx = new E2ETestContext("class-support");
    let result: ProcessContextResult;

    beforeAll(async () => {
        await ctx.setup();
        result = await ctx.runParser("lecture");
    });

    afterAll(async () => {
        await ctx.teardown();
    });

    describe("CreateLecture Command", () => {
        it("should instantiate with valid payload", async () => {
            const { CreateLecture } = await importGeneratedModule<{
                CreateLecture: new (payload: Record<string, unknown>) => {
                    getPayload(): Record<string, unknown>;
                };
            }>(ctx.getOutputFile("lecture", "commands.ts"));

            const cmd = new CreateLecture({
                lectureId: "lecture-1",
                instructorId: "instructor-1",
                title: "Test Lecture",
                credit: 10,
                price: 1000,
            });

            expect(cmd.getPayload().title).toBe("Test Lecture");
            expect(cmd.getPayload().credit).toBe(10);
        });

        it("should execute validate() and create domain objects", async () => {
            const { CreateLecture } = await importGeneratedModule<{
                CreateLecture: new (payload: Record<string, unknown>) => {
                    validate(): {
                        credit: { value: number };
                        price: { amount: number; currency: string };
                    };
                };
            }>(ctx.getOutputFile("lecture", "commands.ts"));

            const cmd = new CreateLecture({
                lectureId: "lecture-1",
                instructorId: "instructor-1",
                title: "Test Lecture",
                credit: 10,
                price: 1000,
            });

            const validated = cmd.validate();

            expect(validated.credit.value).toBe(10);
            expect(validated.price.amount).toBe(1000);
            expect(validated.price.currency).toBe("KRW");
        });

        it("should throw on invalid credit (> 100)", async () => {
            const { CreateLecture } = await importGeneratedModule<{
                CreateLecture: new (payload: Record<string, unknown>) => {
                    validate(): unknown;
                };
            }>(ctx.getOutputFile("lecture", "commands.ts"));

            const cmd = new CreateLecture({
                lectureId: "lecture-1",
                instructorId: "instructor-1",
                title: "Test Lecture",
                credit: 150, // Invalid: > 100
                price: 1000,
            });

            expect(() => cmd.validate()).toThrow("Invalid lesson credit");
        });

        it("should throw on invalid credit (value <= 0)", async () => {
            const { CreateLecture } = await importGeneratedModule<{
                CreateLecture: new (payload: Record<string, unknown>) => {
                    validate(): unknown;
                };
            }>(ctx.getOutputFile("lecture", "commands.ts"));

            const cmd = new CreateLecture({
                lectureId: "lecture-1",
                instructorId: "instructor-1",
                title: "Test Lecture",
                credit: 0, // Invalid: <= 0
                price: 1000,
            });

            expect(() => cmd.validate()).toThrow("Invalid lesson credit");
        });

        it("should throw on invalid price (negative amount)", async () => {
            const { CreateLecture } = await importGeneratedModule<{
                CreateLecture: new (payload: Record<string, unknown>) => {
                    validate(): unknown;
                };
            }>(ctx.getOutputFile("lecture", "commands.ts"));

            const cmd = new CreateLecture({
                lectureId: "lecture-1",
                instructorId: "instructor-1",
                title: "Test Lecture",
                credit: 10,
                price: -100, // Invalid: negative
            });

            expect(() => cmd.validate()).toThrow("Invalid lesson price");
        });
    });

    describe("LessonCredit Domain Object", () => {
        it("should create with valid value (1-100)", async () => {
            const { LessonCredit } = await importGeneratedModule<{
                LessonCredit: new (value: number) => { value: number };
            }>(ctx.getOutputFile("lecture", "domain.ts"));

            const credit = new LessonCredit(50);
            expect(credit.value).toBe(50);
        });

        it("should throw on value > 100", async () => {
            const { LessonCredit } = await importGeneratedModule<{
                LessonCredit: new (value: number) => unknown;
            }>(ctx.getOutputFile("lecture", "domain.ts"));

            expect(() => new LessonCredit(101)).toThrow("Invalid lesson credit");
        });

        it("should throw on value <= 0", async () => {
            const { LessonCredit } = await importGeneratedModule<{
                LessonCredit: new (value: number) => unknown;
            }>(ctx.getOutputFile("lecture", "domain.ts"));

            expect(() => new LessonCredit(0)).toThrow("Invalid lesson credit");
        });

        it("should add credits correctly", async () => {
            const { LessonCredit } = await importGeneratedModule<{
                LessonCredit: new (value: number) => {
                    value: number;
                    add(other: { value: number }): { value: number };
                };
            }>(ctx.getOutputFile("lecture", "domain.ts"));

            const credit1 = new LessonCredit(10);
            const credit2 = new LessonCredit(20);
            const result = credit1.add(credit2);

            expect(result.value).toBe(30);
        });
    });

    describe("LessonPrice Domain Object", () => {
        it("should create with valid amount", async () => {
            const { LessonPrice } = await importGeneratedModule<{
                LessonPrice: new (amount: number, currency: string) => {
                    amount: number;
                    currency: string;
                };
            }>(ctx.getOutputFile("lecture", "domain.ts"));

            const price = new LessonPrice(1000, "KRW");
            expect(price.amount).toBe(1000);
            expect(price.currency).toBe("KRW");
        });

        it("should throw on negative amount", async () => {
            const { LessonPrice } = await importGeneratedModule<{
                LessonPrice: new (amount: number, currency: string) => unknown;
            }>(ctx.getOutputFile("lecture", "domain.ts"));

            expect(() => new LessonPrice(-100, "KRW")).toThrow(
                "Invalid lesson price"
            );
        });

        it("should throw on zero amount", async () => {
            const { LessonPrice } = await importGeneratedModule<{
                LessonPrice: new (amount: number, currency: string) => unknown;
            }>(ctx.getOutputFile("lecture", "domain.ts"));

            expect(() => new LessonPrice(0, "KRW")).toThrow("Invalid lesson price");
        });

        it("should apply discount correctly", async () => {
            const { LessonPrice } = await importGeneratedModule<{
                LessonPrice: new (amount: number, currency: string) => {
                    amount: number;
                    currency: string;
                    applyDiscount(percent: number): { amount: number; currency: string };
                };
            }>(ctx.getOutputFile("lecture", "domain.ts"));

            const price = new LessonPrice(1000, "KRW");
            const discounted = price.applyDiscount(10); // 10% discount

            expect(discounted.amount).toBe(900);
            expect(discounted.currency).toBe("KRW");
        });
    });
});
