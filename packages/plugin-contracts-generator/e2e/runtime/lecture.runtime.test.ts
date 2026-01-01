import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { E2ETestContext, importGeneratedModule } from "../helpers";

describe("Runtime: Lecture", () => {
    const ctx = new E2ETestContext("lecture");

    beforeAll(async () => {
        await ctx.setup();
        await ctx.runParser();
    });

    afterAll(async () => {
        await ctx.teardown();
    });

    describe("CreateLecture Command", () => {
        it("should instantiate and access payload", async () => {
            const { CreateLecture } = await importGeneratedModule<{
                CreateLecture: new (payload: Record<string, unknown>) => {
                    getPayload(): { title: string; instructorId: string };
                };
            }>(ctx.getOutputFile("lecture", "commands.ts"));

            const cmd = new CreateLecture({
                title: "Introduction to Programming",
                instructorId: "instructor-123",
            });

            const payload = cmd.getPayload();
            expect(payload.title).toBe("Introduction to Programming");
            expect(payload.instructorId).toBe("instructor-123");
        });

        it("should preserve payload types correctly", async () => {
            const { CreateLecture } = await importGeneratedModule<{
                CreateLecture: new (payload: Record<string, unknown>) => {
                    getPayload(): Record<string, unknown>;
                };
            }>(ctx.getOutputFile("lecture", "commands.ts"));

            const cmd = new CreateLecture({
                title: "Test",
                instructorId: "inst-1",
            });

            const payload = cmd.getPayload();
            expect(typeof payload.title).toBe("string");
            expect(typeof payload.instructorId).toBe("string");
        });
    });

    describe("LectureCreated Event", () => {
        it("should instantiate with proper payload", async () => {
            const { LectureCreated } = await importGeneratedModule<{
                LectureCreated: new (payload: Record<string, unknown>) => {
                    getPayload(): {
                        lectureId: string;
                        title: string;
                        timestamp: number;
                        userId: string;
                    };
                };
            }>(ctx.getOutputFile("lecture", "events.ts"));

            const event = new LectureCreated({
                lectureId: "lecture-456",
                title: "Advanced TypeScript",
                timestamp: Date.now(),
                userId: "user-789",
            });

            const payload = event.getPayload();
            expect(payload.lectureId).toBe("lecture-456");
            expect(payload.title).toBe("Advanced TypeScript");
            expect(typeof payload.timestamp).toBe("number");
            expect(payload.userId).toBe("user-789");
        });
    });

    describe("LectureDeleted Event", () => {
        it("should instantiate with proper payload", async () => {
            const { LectureDeleted } = await importGeneratedModule<{
                LectureDeleted: new (payload: Record<string, unknown>) => {
                    getPayload(): { lectureId: string };
                };
            }>(ctx.getOutputFile("lecture", "events.ts"));

            const event = new LectureDeleted({
                lectureId: "lecture-to-delete",
            });

            const payload = event.getPayload();
            expect(payload.lectureId).toBe("lecture-to-delete");
        });
    });

    describe("Module exports", () => {
        it("should export all classes from index.ts", async () => {
            const module = await importGeneratedModule<Record<string, unknown>>(
                ctx.getOutputFile("lecture", "index.ts")
            );

            expect(module.CreateLecture).toBeDefined();
            expect(module.LectureCreated).toBeDefined();
            expect(module.LectureDeleted).toBeDefined();
        });
    });
});
