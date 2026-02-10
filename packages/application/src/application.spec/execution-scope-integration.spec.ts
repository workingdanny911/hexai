import { beforeEach, describe, expect, test } from "vitest";

import { DummyMessage } from "@hexaijs/core/test";

import { ApplicationContext } from "@/application-context";
import { ApplicationBuilder } from "@/application";
import { ExecutionScope } from "@/execution-scope";
import { DummyCommand, DummyEvent, DummyQuery } from "@/test";

class TestApplicationContext implements ApplicationContext {}

describe("Application, execution scope integration", () => {
    let sutBuilder: ApplicationBuilder;

    beforeEach(() => {
        sutBuilder = new ApplicationBuilder().withApplicationContext(
            new TestApplicationContext()
        );
    });

    describe("executeCommand", () => {
        test("inherits security context from enclosing execution scope", async () => {
            const securityContext = { role: "admin" };
            let captured: unknown;

            const application = sutBuilder
                .withCommandHandler(DummyCommand, () => ({
                    async execute() {
                        captured = ExecutionScope.getSecurityContext();
                    },
                }))
                .build();

            await ExecutionScope.run({ securityContext }, async () => {
                const command = new DummyCommand();
                await application.executeCommand(command);
            });

            expect(captured).toEqual(securityContext);
        });

        test("sets causation from command trace", async () => {
            const command = new DummyCommand();
            let captured: unknown;

            const application = sutBuilder
                .withCommandHandler(DummyCommand, () => ({
                    async execute() {
                        captured = ExecutionScope.getCausation();
                    },
                }))
                .build();

            await application.executeCommand(command);

            expect(captured).toEqual(command.asTrace());
        });

        test("sets correlation from command when present", async () => {
            const rootMessage = DummyMessage.create();
            const command = new DummyCommand().withCorrelation(
                rootMessage.asTrace()
            );
            let captured: unknown;

            const application = sutBuilder
                .withCommandHandler(DummyCommand, () => ({
                    async execute() {
                        captured = ExecutionScope.getCorrelation();
                    },
                }))
                .build();

            await application.executeCommand(command);

            expect(captured).toEqual(rootMessage.asTrace());
        });

        test("handles command without security context", async () => {
            const command = new DummyCommand();
            let captured: unknown = "sentinel";

            const application = sutBuilder
                .withCommandHandler(DummyCommand, () => ({
                    async execute() {
                        captured = ExecutionScope.getSecurityContext();
                    },
                }))
                .build();

            await application.executeCommand(command);

            expect(captured).toBeUndefined();
        });
    });

    describe("executeQuery", () => {
        test("inherits security context from enclosing execution scope", async () => {
            const securityContext = { role: "viewer" };
            let captured: unknown;

            const application = sutBuilder
                .withQueryHandler(DummyQuery, () => ({
                    async execute() {
                        captured = ExecutionScope.getSecurityContext();
                    },
                }))
                .build();

            await ExecutionScope.run({ securityContext }, async () => {
                const query = new DummyQuery("q1");
                await application.executeQuery(query);
            });

            expect(captured).toEqual(securityContext);
        });

        test("sets causation from query trace", async () => {
            const query = new DummyQuery();
            let captured: unknown;

            const application = sutBuilder
                .withQueryHandler(DummyQuery, () => ({
                    async execute() {
                        captured = ExecutionScope.getCausation();
                    },
                }))
                .build();

            await application.executeQuery(query);

            expect(captured).toEqual(query.asTrace());
        });
    });

    describe("handleEvent", () => {
        test("sets causation from event trace", async () => {
            const event = new DummyEvent();
            let captured: unknown;

            const application = sutBuilder
                .withEventHandler(() => ({
                    getId: () => "test-eh",
                    canHandle: () => true,
                    async handle() {
                        captured = ExecutionScope.getCausation();
                    },
                }))
                .build();

            await application.handleEvent(event);

            expect(captured).toEqual(event.asTrace());
        });

        test("all concurrent event handlers share the same scope", async () => {
            const event = new DummyEvent();
            const captured: unknown[] = [];

            const application = sutBuilder
                .withEventHandler(() => ({
                    getId: () => "eh-1",
                    canHandle: () => true,
                    async handle() {
                        captured.push(ExecutionScope.getCausation());
                    },
                }))
                .withEventHandler(() => ({
                    getId: () => "eh-2",
                    canHandle: () => true,
                    async handle() {
                        captured.push(ExecutionScope.getCausation());
                    },
                }))
                .build();

            await application.handleEvent(event);

            expect(captured).toHaveLength(2);
            expect(captured[0]).toEqual(event.asTrace());
            expect(captured[1]).toEqual(event.asTrace());
        });
    });

});
