import { describe, it, expect, beforeEach } from "vitest";
import { ReexportGenerator, ReexportFile } from "./reexport-generator";
import { createInMemoryFileSystem } from "./test-utils";

describe("ReexportGenerator", () => {
    let generator: ReexportGenerator;
    let fs: ReturnType<typeof createInMemoryFileSystem>;

    beforeEach(() => {
        fs = createInMemoryFileSystem();
        generator = new ReexportGenerator({ fileSystem: fs });
    });

    describe("analyze", () => {
        it("should extract symbols from rewritten imports", async () => {
            fs.files.set(
                "/output/commands/IO.ts",
                `
                import { LiberaUseCaseRequest } from "@libera/contracts/common/request";
                import { PublicCommand } from "@libera/contracts/decorators";

                export class CreateLecture extends LiberaUseCaseRequest {}
            `
            );

            const result = await generator.analyze({
                files: ["/output/commands/IO.ts"],
                pathAliasRewrites: new Map([
                    ["@libera/common", "@libera/contracts/common"],
                    [
                        "@hexaijs/contracts/decorators",
                        "@libera/contracts/decorators",
                    ],
                ]),
            });

            expect(result).toHaveLength(2);

            const commonRequest = result.find(
                (r) => r.relativePath === "common/request.ts"
            );
            expect(commonRequest).toBeDefined();
            expect(commonRequest!.originalModule).toBe(
                "@libera/common/request"
            );
            expect(commonRequest!.symbols).toEqual(["LiberaUseCaseRequest"]);

            const decorators = result.find(
                (r) => r.relativePath === "decorators.ts"
            );
            expect(decorators).toBeDefined();
            expect(decorators!.originalModule).toBe(
                "@hexaijs/contracts/decorators"
            );
            expect(decorators!.symbols).toEqual(["PublicCommand"]);
        });

        it("should merge symbols from multiple files", async () => {
            fs.files.set(
                "/output/file1.ts",
                `
                import { UserId } from "@libera/contracts/common";
            `
            );
            fs.files.set(
                "/output/file2.ts",
                `
                import { VideoLessonType } from "@libera/contracts/common";
            `
            );
            fs.files.set(
                "/output/file3.ts",
                `
                import { UserId, LectureId } from "@libera/contracts/common";
            `
            );

            const result = await generator.analyze({
                files: [
                    "/output/file1.ts",
                    "/output/file2.ts",
                    "/output/file3.ts",
                ],
                pathAliasRewrites: new Map([
                    ["@libera/common", "@libera/contracts/common"],
                ]),
            });

            expect(result).toHaveLength(1);
            const common = result[0];
            expect(common.relativePath).toBe("common.ts");
            expect(common.originalModule).toBe("@libera/common");
            expect(common.symbols).toEqual([
                "LectureId",
                "UserId",
                "VideoLessonType",
            ]);
        });

        it("should handle type-only imports", async () => {
            fs.files.set(
                "/output/file.ts",
                `
                import type { UserId } from "@libera/contracts/common";
            `
            );

            const result = await generator.analyze({
                files: ["/output/file.ts"],
                pathAliasRewrites: new Map([
                    ["@libera/common", "@libera/contracts/common"],
                ]),
            });

            expect(result).toHaveLength(1);
            expect(result[0].isTypeOnly).toBe(true);
        });

        it("should mark as value import if any import is not type-only", async () => {
            fs.files.set(
                "/output/file1.ts",
                `
                import type { UserId } from "@libera/contracts/common";
            `
            );
            fs.files.set(
                "/output/file2.ts",
                `
                import { VideoLessonType } from "@libera/contracts/common";
            `
            );

            const result = await generator.analyze({
                files: ["/output/file1.ts", "/output/file2.ts"],
                pathAliasRewrites: new Map([
                    ["@libera/common", "@libera/contracts/common"],
                ]),
            });

            expect(result).toHaveLength(1);
            expect(result[0].isTypeOnly).toBe(false);
        });

        it("should ignore imports that don't match rewritten prefixes", async () => {
            fs.files.set(
                "/output/file.ts",
                `
                import { Message } from "@hexaijs/core";
                import { Something } from "./local";
                import { UserId } from "@libera/contracts/common";
            `
            );

            const result = await generator.analyze({
                files: ["/output/file.ts"],
                pathAliasRewrites: new Map([
                    ["@libera/common", "@libera/contracts/common"],
                ]),
            });

            expect(result).toHaveLength(1);
            expect(result[0].symbols).toEqual(["UserId"]);
        });

        it("should handle aliased imports correctly", async () => {
            fs.files.set(
                "/output/file.ts",
                `
                import { UserId as UID, VideoLessonType } from "@libera/contracts/common";
            `
            );

            const result = await generator.analyze({
                files: ["/output/file.ts"],
                pathAliasRewrites: new Map([
                    ["@libera/common", "@libera/contracts/common"],
                ]),
            });

            expect(result).toHaveLength(1);
            // Should use original name "UserId", not the alias "UID"
            expect(result[0].symbols).toEqual(["UserId", "VideoLessonType"]);
        });

        it("should handle deep subpaths", async () => {
            fs.files.set(
                "/output/file.ts",
                `
                import { SecurityContext } from "@libera/contracts/common/auth/security";
            `
            );

            const result = await generator.analyze({
                files: ["/output/file.ts"],
                pathAliasRewrites: new Map([
                    ["@libera/common", "@libera/contracts/common"],
                ]),
            });

            expect(result).toHaveLength(1);
            expect(result[0].relativePath).toBe("common/auth/security.ts");
            expect(result[0].originalModule).toBe(
                "@libera/common/auth/security"
            );
        });
    });

    describe("generate", () => {
        it("should generate re-export files", async () => {
            const reexportFiles: ReexportFile[] = [
                {
                    relativePath: "common/request.ts",
                    originalModule: "@libera/common/request",
                    symbols: ["LiberaUseCaseRequest"],
                    isTypeOnly: false,
                },
                {
                    relativePath: "decorators.ts",
                    originalModule:
                        "@hexaijs/contracts/decorators",
                    symbols: ["PublicCommand", "PublicEvent"],
                    isTypeOnly: false,
                },
            ];

            const generatedFiles = await generator.generate({
                outputDir: "/output",
                reexportFiles,
            });

            expect(generatedFiles).toHaveLength(2);

            const requestContent = fs.files.get("/output/common/request.ts");
            expect(requestContent).toBe(
                `export { LiberaUseCaseRequest } from "@libera/common/request";\n`
            );

            const decoratorsContent = fs.files.get("/output/decorators.ts");
            expect(decoratorsContent).toBe(
                `export { PublicCommand, PublicEvent } from "@hexaijs/contracts/decorators";\n`
            );
        });

        it("should generate type-only exports when all imports are type-only", async () => {
            const reexportFiles: ReexportFile[] = [
                {
                    relativePath: "common.ts",
                    originalModule: "@libera/common",
                    symbols: ["UserId"],
                    isTypeOnly: true,
                },
            ];

            await generator.generate({
                outputDir: "/output",
                reexportFiles,
            });

            const content = fs.files.get("/output/common.ts");
            expect(content).toBe(
                `export type { UserId } from "@libera/common";\n`
            );
        });
    });
});
