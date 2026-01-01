import { describe, test, expect } from "vitest";

import { RegistryGenerator, ContextMessages } from "./registry-generator";
import type { DomainEvent, Command } from "./domain/types";

describe("RegistryGenerator", () => {
    const generator = new RegistryGenerator({
        messageRegistryImport: "@hexaijs/plugin-contracts-generator/runtime",
    });

    function createEvent(name: string): DomainEvent {
        return {
            name,
            messageType: "event",
            sourceFile: {
                absolutePath: "/test/events.ts",
                relativePath: "events.ts",
            },
            fields: [],
            sourceText: `class ${name} {}`,
            imports: [],
        };
    }

    function createCommand(name: string): Command {
        return {
            name,
            messageType: "command",
            sourceFile: {
                absolutePath: "/test/commands.ts",
                relativePath: "commands.ts",
            },
            fields: [],
            sourceText: `class ${name} {}`,
            imports: [],
        };
    }

    test("generates empty registry when no messages", () => {
        const result = generator.generate([]);

        expect(result).toContain(
            'import { MessageRegistry } from "@hexaijs/plugin-contracts-generator/runtime"'
        );
        expect(result).toContain(
            "export const messageRegistry = new MessageRegistry();"
        );
    });

    test("generates registry with single event", () => {
        const contexts: ContextMessages[] = [
            {
                contextName: "lecture",
                events: [createEvent("LectureCreated")],
                commands: [],
            },
        ];

        const result = generator.generate(contexts);

        expect(result).toContain(
            'import { MessageRegistry } from "@hexaijs/plugin-contracts-generator/runtime"'
        );
        expect(result).toContain('import { LectureCreated } from "./lecture"');
        expect(result).toContain(
            "export const messageRegistry = new MessageRegistry()"
        );
        expect(result).toContain(".register(LectureCreated)");
    });

    test("generates registry with multiple messages from single context", () => {
        const contexts: ContextMessages[] = [
            {
                contextName: "lecture",
                events: [
                    createEvent("LectureCreated"),
                    createEvent("LectureExpanded"),
                ],
                commands: [createCommand("CreateLecture")],
            },
        ];

        const result = generator.generate(contexts);

        expect(result).toContain(
            'import { LectureCreated, LectureExpanded, CreateLecture } from "./lecture"'
        );
        expect(result).toContain(".register(LectureCreated)");
        expect(result).toContain(".register(LectureExpanded)");
        expect(result).toContain(".register(CreateLecture)");
    });

    test("generates registry with multiple contexts", () => {
        const contexts: ContextMessages[] = [
            {
                contextName: "lecture",
                events: [createEvent("LectureCreated")],
                commands: [],
            },
            {
                contextName: "video-lesson",
                events: [createEvent("VideoLessonStarted")],
                commands: [createCommand("StartVideoLesson")],
            },
        ];

        const result = generator.generate(contexts);

        expect(result).toContain('import { LectureCreated } from "./lecture"');
        expect(result).toContain(
            'import { VideoLessonStarted, StartVideoLesson } from "./video-lesson"'
        );
        expect(result).toContain(".register(LectureCreated)");
        expect(result).toContain(".register(VideoLessonStarted)");
        expect(result).toContain(".register(StartVideoLesson)");
    });

    test("skips context with no messages", () => {
        const contexts: ContextMessages[] = [
            {
                contextName: "empty-context",
                events: [],
                commands: [],
            },
            {
                contextName: "lecture",
                events: [createEvent("LectureCreated")],
                commands: [],
            },
        ];

        const result = generator.generate(contexts);

        expect(result).not.toContain("empty-context");
        expect(result).toContain('import { LectureCreated } from "./lecture"');
    });

    test("generates valid chained syntax", () => {
        const contexts: ContextMessages[] = [
            {
                contextName: "lecture",
                events: [createEvent("A"), createEvent("B")],
                commands: [createCommand("C")],
            },
        ];

        const result = generator.generate(contexts);

        expect(result).toMatch(
            /new MessageRegistry\(\)\s+\.register\(A\)\s+\.register\(B\)\s+\.register\(C\);/
        );
    });

    test("uses custom messageRegistryImport", () => {
        const customGenerator = new RegistryGenerator({
            messageRegistryImport: "@hexaijs/core",
        });

        const result = customGenerator.generate([
            {
                contextName: "test",
                events: [createEvent("TestEvent")],
                commands: [],
            },
        ]);

        expect(result).toContain(
            'import { MessageRegistry } from "@hexaijs/core"'
        );
    });

    describe("namespace mode", () => {
        const nsGenerator = new RegistryGenerator({
            messageRegistryImport: "@hexaijs/core",
            useNamespace: true,
        });

        test("generates namespace imports instead of named imports", () => {
            const contexts: ContextMessages[] = [
                {
                    contextName: "lecture",
                    events: [createEvent("LectureCreated")],
                    commands: [],
                },
            ];

            const result = nsGenerator.generate(contexts);

            // namespace import 사용
            expect(result).toContain('import * as lecture from "./lecture"');
            // named import 사용하지 않음
            expect(result).not.toContain("import { LectureCreated }");
        });

        test("generates namespace exports", () => {
            const contexts: ContextMessages[] = [
                {
                    contextName: "lecture",
                    events: [createEvent("LectureCreated")],
                    commands: [],
                },
                {
                    contextName: "video-lesson",
                    events: [createEvent("VideoLessonStarted")],
                    commands: [],
                },
            ];

            const result = nsGenerator.generate(contexts);

            expect(result).toContain('export * as lecture from "./lecture"');
            expect(result).toContain(
                'export * as videoLesson from "./video-lesson"'
            );
        });

        test("registers messages with namespace prefix", () => {
            const contexts: ContextMessages[] = [
                {
                    contextName: "lecture",
                    events: [createEvent("LectureCreated")],
                    commands: [createCommand("CreateLecture")],
                },
            ];

            const result = nsGenerator.generate(contexts);

            expect(result).toContain(".register(lecture.LectureCreated)");
            expect(result).toContain(".register(lecture.CreateLecture)");
        });

        test("handles name collision with namespace prefix", () => {
            const contexts: ContextMessages[] = [
                {
                    contextName: "resources",
                    events: [createEvent("StudentRegistered")],
                    commands: [],
                },
                {
                    contextName: "step1",
                    events: [createEvent("StudentRegistered")],
                    commands: [],
                },
            ];

            const result = nsGenerator.generate(contexts);

            // 같은 이름이지만 namespace로 구분됨
            expect(result).toContain(".register(resources.StudentRegistered)");
            expect(result).toContain(".register(step1.StudentRegistered)");
            // named import는 사용하지 않음 (충돌 방지)
            expect(result).not.toContain("import { StudentRegistered }");
        });

        test("converts kebab-case context name to camelCase for namespace", () => {
            const contexts: ContextMessages[] = [
                {
                    contextName: "video-lesson",
                    events: [createEvent("VideoStarted")],
                    commands: [],
                },
            ];

            const result = nsGenerator.generate(contexts);

            // import는 원래 경로 유지
            expect(result).toContain(
                'import * as videoLesson from "./video-lesson"'
            );
            // export도 camelCase namespace
            expect(result).toContain(
                'export * as videoLesson from "./video-lesson"'
            );
            // registration도 camelCase
            expect(result).toContain(".register(videoLesson.VideoStarted)");
        });
    });
});
