import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { readFile } from "fs/promises";
import { join } from "path";

import {
    E2ETestContext,
    expectFileContains,
    expectGeneratedFiles,
    expectExtractionResult,
    expectCommands,
} from "../helpers";
import type { ProcessContextResult } from "../../src/index";
import { ResponseNamingConvention } from "../../src/domain/types";

/**
 * E2E Tests for Response Contracts Feature
 *
 * Tests the full pipeline integration where:
 * 1. Application config sets global responseNamingConventions
 * 2. Context can override with its own conventions
 * 3. Response types are automatically exported in contracts
 *
 * resolve(application, contracts) convention:
 * - application.config.ts provides global settings
 * - context-level config can override specific settings
 */
describe("E2E: Response Contracts", () => {
    const ctx = new E2ETestContext("response-contracts");
    let result: ProcessContextResult;

    beforeAll(async () => {
        await ctx.setup();
        result = await ctx.runParser({
            contextName: "response-contracts",
            responseNamingConventions: [
                { messageSuffix: "Command", responseSuffix: "Result" },
                { messageSuffix: "Query", responseSuffix: "QueryResult" },
            ],
        });
    });

    afterAll(async () => {
        await ctx.teardown();
    });

    describe("Extraction", () => {
        it("should extract commands and queries", () => {
            expectExtractionResult(result, {
                commandCount: 4,
            });
        });

        it("should extract expected commands", () => {
            expectCommands(result, [
                "CreateLectureCommand",
                "DeleteLectureCommand",
                "UpdateLectureCommand",
                "PublishLectureCommand",
            ]);
        });
    });

    describe("File Generation", () => {
        it("should generate expected files", () => {
            expectGeneratedFiles(ctx.getOutputDir(), "response-contracts", [
                "index.ts",
                "commands.ts",
                "queries.ts",
                "types.ts",
            ]);
        });

        describe("Response Types in commands.ts", () => {
            it("should contain command classes", async () => {
                await expectFileContains(
                    ctx.getOutputFile("response-contracts/commands.ts"),
                    [
                        "export class CreateLectureCommand",
                        "export class DeleteLectureCommand",
                        "export class UpdateLectureCommand",
                        "export class PublishLectureCommand",
                    ]
                );
            });

            it("should export response type matched by naming convention", async () => {
                // CreateLectureCommand should match CreateLectureResult
                await expectFileContains(
                    ctx.getOutputFile("response-contracts/commands.ts"),
                    ["export type CreateLectureResult"]
                );
            });

            it("should export response type specified explicitly", async () => {
                // @PublicCommand({ response: "DeleteLectureResponse" })
                await expectFileContains(
                    ctx.getOutputFile("response-contracts/commands.ts"),
                    ["export type DeleteLectureResponse"]
                );
            });

            it("should keep already exported response types", async () => {
                // UpdateLectureResult is already exported
                await expectFileContains(
                    ctx.getOutputFile("response-contracts/commands.ts"),
                    ["export type UpdateLectureResult"]
                );
            });
        });

        describe("Response Types in queries.ts", () => {
            it("should export interface matched by naming convention", async () => {
                // GetLectureQuery should match GetLectureQueryResult
                await expectFileContains(
                    ctx.getOutputFile("response-contracts/queries.ts"),
                    ["export interface GetLectureQueryResult"]
                );
            });

            it("should export interface specified explicitly", async () => {
                // @PublicQuery({ response: "LectureListResponse" })
                await expectFileContains(
                    ctx.getOutputFile("response-contracts/queries.ts"),
                    ["export interface LectureListResponse"]
                );
            });
        });
    });
});
