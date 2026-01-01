import { describe, expect, it } from "vitest";

import { Parser } from "./parser";
import type {
    ArrayType,
    Command,
    DecoratorNames,
    DomainEvent,
    Field,
    IntersectionType,
    ObjectType,
    PrimitiveType,
    Query,
    ReferenceType,
    SourceFile,
    TypeDefinition,
} from "./domain";

const testSourceFile: SourceFile = {
    absolutePath: "/test/input.ts",
    relativePath: "input.ts",
};

describe("Parser", () => {
    describe("parsing @PublicEvent decorated class", () => {
        it("should extract class name from a @PublicEvent decorated class", () => {
            const sourceCode = `
        import { Message } from '@hexaijs/core';

        @PublicEvent()
        export class LectureCreated extends Message<{
          lectureId: string;
        }> {}
      `;

            const parser = new Parser();
            const result = parser.parse(sourceCode, testSourceFile);

            expect(result.events).toHaveLength(1);
            const event = result.events[0] as DomainEvent;
            expect(event.name).toBe("LectureCreated");
            expect(event.messageType).toBe("event");
        });

        it("should extract fields from generic type argument of Message<T>", () => {
            const sourceCode = `
        import { Message } from '@hexaijs/core';

        @PublicEvent()
        export class LectureCreated extends Message<{
          lectureId: string;
          studentUserId: string;
          count: number;
        }> {}
      `;

            const parser = new Parser();
            const result = parser.parse(sourceCode, testSourceFile);

            expect(result.events).toHaveLength(1);
            const event = result.events[0] as DomainEvent;
            expect(event.fields).toHaveLength(3);

            const field1 = event.fields[0] as Field;
            expect(field1.name).toBe("lectureId");
            expect((field1.type as PrimitiveType).kind).toBe("primitive");
            expect((field1.type as PrimitiveType).name).toBe("string");

            const field2 = event.fields[1] as Field;
            expect(field2.name).toBe("studentUserId");

            const field3 = event.fields[2] as Field;
            expect(field3.name).toBe("count");
            expect((field3.type as PrimitiveType).kind).toBe("primitive");
            expect((field3.type as PrimitiveType).name).toBe("number");
        });

        it("should parse unknown types as reference types", () => {
            const sourceCode = `
        import { Message } from '@hexaijs/core';

        @PublicEvent()
        export class LectureCreated extends Message<{
          lectureId: string;
          student: UserId;
        }> {}
      `;

            const parser = new Parser();
            const result = parser.parse(sourceCode, testSourceFile);

            expect(result.events).toHaveLength(1);
            const event = result.events[0] as DomainEvent;
            expect(event.fields).toHaveLength(2);

            const studentField = event.fields[1] as Field;
            expect(studentField.name).toBe("student");
            expect((studentField.type as ReferenceType).kind).toBe("reference");
            expect((studentField.type as ReferenceType).name).toBe("UserId");
        });

        it("should detect optional fields marked with question mark syntax", () => {
            const sourceCode = `
        import { Message } from '@hexaijs/core';

        @PublicEvent()
        export class LectureCreated extends Message<{
          lectureId: string;
          consultantUserId?: string;
        }> {}
      `;

            const parser = new Parser();
            const result = parser.parse(sourceCode, testSourceFile);

            expect(result.events).toHaveLength(1);
            const event = result.events[0] as DomainEvent;
            expect(event.fields).toHaveLength(2);

            const lectureIdField = event.fields[0] as Field;
            expect(lectureIdField.name).toBe("lectureId");
            expect(lectureIdField.optional).toBe(false);

            const consultantField = event.fields[1] as Field;
            expect(consultantField.name).toBe("consultantUserId");
            expect(consultantField.optional).toBe(true);
        });
    });

    describe("parsing type reference as generic argument", () => {
        it("should mark payload as reference type when generic argument is a type reference", () => {
            const sourceCode = `
        import { Message } from '@hexaijs/core';

        type LectureCreatedPayload = {
          lectureId: string;
          studentUserId: string;
        };

        @PublicEvent()
        export class LectureCreated extends Message<LectureCreatedPayload> {}
      `;

            const parser = new Parser();
            const result = parser.parse(sourceCode, testSourceFile);

            expect(result.events).toHaveLength(1);
            const event = result.events[0] as DomainEvent;
            expect(event.name).toBe("LectureCreated");

            expect(event.payloadType).toBeDefined();
            expect((event.payloadType as ReferenceType).kind).toBe("reference");
            expect((event.payloadType as ReferenceType).name).toBe(
                "LectureCreatedPayload"
            );

            expect(event.fields).toHaveLength(0);
        });
    });

    describe("parsing @PublicCommand decorated class", () => {
        it("should extract command with name and fields from a @PublicCommand decorated class", () => {
            const sourceCode = `
        import { Request } from '@hexaijs/core';

        @PublicCommand()
        export class CompensateLessonCredits extends Request<{
          lectureId: string;
          credits: number;
        }> {}
      `;

            const parser = new Parser();
            const result = parser.parse(sourceCode, testSourceFile);

            expect(result.commands).toBeDefined();
            expect(result.commands).toHaveLength(1);

            const command = result.commands[0] as Command;
            expect(command.name).toBe("CompensateLessonCredits");
            expect(command.messageType).toBe("command");

            expect(command.fields).toHaveLength(2);

            const lectureIdField = command.fields[0] as Field;
            expect(lectureIdField.name).toBe("lectureId");
            expect((lectureIdField.type as PrimitiveType).kind).toBe(
                "primitive"
            );
            expect((lectureIdField.type as PrimitiveType).name).toBe("string");

            const creditsField = command.fields[1] as Field;
            expect(creditsField.name).toBe("credits");
            expect((creditsField.type as PrimitiveType).kind).toBe("primitive");
            expect((creditsField.type as PrimitiveType).name).toBe("number");
        });
    });

    describe("parsing boolean type", () => {
        it("should parse boolean type as primitive with name boolean", () => {
            const sourceCode = `
        import { Message } from '@hexaijs/core';

        @PublicEvent()
        export class UserUpdated extends Message<{
          isActive: boolean;
        }> {}
      `;

            const parser = new Parser();
            const result = parser.parse(sourceCode, testSourceFile);

            expect(result.events).toHaveLength(1);
            const event = result.events[0] as DomainEvent;
            expect(event.fields).toHaveLength(1);

            const isActiveField = event.fields[0] as Field;
            expect(isActiveField.name).toBe("isActive");
            expect((isActiveField.type as PrimitiveType).kind).toBe(
                "primitive"
            );
            expect((isActiveField.type as PrimitiveType).name).toBe("boolean");
        });
    });

    describe("parsing array types", () => {
        it("should parse fields with array type syntax as ArrayType", () => {
            const sourceCode = `
        import { Message } from '@hexaijs/core';

        @PublicEvent()
        export class ItemsAdded extends Message<{
          items: string[];
          counts: number[];
        }> {}
      `;

            const parser = new Parser();
            const result = parser.parse(sourceCode, testSourceFile);

            expect(result.events).toHaveLength(1);
            const event = result.events[0] as DomainEvent;
            expect(event.fields).toHaveLength(2);

            const itemsField = event.fields[0] as Field;
            expect(itemsField.name).toBe("items");
            expect((itemsField.type as ArrayType).kind).toBe("array");
            expect(
                ((itemsField.type as ArrayType).elementType as PrimitiveType)
                    .kind
            ).toBe("primitive");
            expect(
                ((itemsField.type as ArrayType).elementType as PrimitiveType)
                    .name
            ).toBe("string");

            const countsField = event.fields[1] as Field;
            expect(countsField.name).toBe("counts");
            expect((countsField.type as ArrayType).kind).toBe("array");
            expect(
                ((countsField.type as ArrayType).elementType as PrimitiveType)
                    .kind
            ).toBe("primitive");
            expect(
                ((countsField.type as ArrayType).elementType as PrimitiveType)
                    .name
            ).toBe("number");
        });
    });

    describe("sourceFile information", () => {
        it("should include sourceFile information in parsed events", () => {
            const sourceCode = `
        import { Message } from '@hexaijs/core';

        @PublicEvent()
        export class LectureCreated extends Message<{
          lectureId: string;
        }> {}
      `;

            const customSourceFile: SourceFile = {
                absolutePath:
                    "/Users/test/project/src/events/lecture-created.ts",
                relativePath: "src/events/lecture-created.ts",
            };

            const parser = new Parser();
            const result = parser.parse(sourceCode, customSourceFile);

            expect(result.events).toHaveLength(1);
            const event = result.events[0] as DomainEvent;
            expect(event.sourceFile).toEqual(customSourceFile);
            expect(event.sourceFile.absolutePath).toBe(
                "/Users/test/project/src/events/lecture-created.ts"
            );
            expect(event.sourceFile.relativePath).toBe(
                "src/events/lecture-created.ts"
            );
        });

        it("should include sourceFile information in parsed commands", () => {
            const sourceCode = `
        import { Request } from '@hexaijs/core';

        @PublicCommand()
        export class CreateLecture extends Request<{
          lectureId: string;
        }> {}
      `;

            const customSourceFile: SourceFile = {
                absolutePath:
                    "/Users/test/project/src/commands/create-lecture.ts",
                relativePath: "src/commands/create-lecture.ts",
            };

            const parser = new Parser();
            const result = parser.parse(sourceCode, customSourceFile);

            expect(result.commands).toHaveLength(1);
            const command = result.commands[0] as Command;
            expect(command.sourceFile).toEqual(customSourceFile);
            expect(command.sourceFile.absolutePath).toBe(
                "/Users/test/project/src/commands/create-lecture.ts"
            );
            expect(command.sourceFile.relativePath).toBe(
                "src/commands/create-lecture.ts"
            );
        });
    });

    describe("custom decorator names", () => {
        // Tests for configurable decorator names in parser
        // When decoratorNames is provided, the parser should recognize those
        // decorators instead of the default @PublicEvent, @PublicCommand, @PublicQuery

        it("should parse class with custom event decorator", () => {
            // Arrange: Source with custom @ContractEvent() decorator
            const sourceCode = `
        import { Message } from '@hexaijs/core';

        @ContractEvent()
        export class OrderPlaced extends Message<{
          orderId: string;
          customerId: string;
        }> {}
      `;

            // Act: Parser with custom decoratorNames should extract it as event
            const customDecoratorNames: DecoratorNames = {
                event: "ContractEvent",
                command: "ContractCommand",
                query: "ContractQuery",
            };
            const parser = new Parser({ decoratorNames: customDecoratorNames });
            const result = parser.parse(sourceCode, testSourceFile);

            // Assert: Should be parsed as an event
            expect(result.events).toHaveLength(1);
            const event = result.events[0] as DomainEvent;
            expect(event.name).toBe("OrderPlaced");
            expect(event.messageType).toBe("event");
            expect(event.fields).toHaveLength(2);
        });

        it("should parse class with custom command decorator", () => {
            // Arrange: Source with custom @ExternalCommand() decorator
            const sourceCode = `
        import { Request } from '@hexaijs/core';

        @ExternalCommand()
        export class PlaceOrder extends Request<{
          productId: string;
          quantity: number;
        }> {}
      `;

            // Act: Parser with custom decoratorNames should extract it as command
            const customDecoratorNames: DecoratorNames = {
                event: "ContractEvent",
                command: "ExternalCommand",
                query: "ContractQuery",
            };
            const parser = new Parser({ decoratorNames: customDecoratorNames });
            const result = parser.parse(sourceCode, testSourceFile);

            // Assert: Should be parsed as a command
            expect(result.commands).toHaveLength(1);
            const command = result.commands[0] as Command;
            expect(command.name).toBe("PlaceOrder");
            expect(command.messageType).toBe("command");
            expect(command.fields).toHaveLength(2);
        });

        it("should parse class with custom query decorator", () => {
            // Arrange: Source with custom @APIQuery() decorator
            const sourceCode = `
        import { Request } from '@hexaijs/core';

        @APIQuery()
        export class GetOrderDetails extends Request<{
          orderId: string;
        }> {}
      `;

            // Act: Parser with custom decoratorNames should extract it as query
            const customDecoratorNames: DecoratorNames = {
                event: "ContractEvent",
                command: "ExternalCommand",
                query: "APIQuery",
            };
            const parser = new Parser({ decoratorNames: customDecoratorNames });
            const result = parser.parse(sourceCode, testSourceFile);

            // Assert: Should be parsed as a query
            expect(result.queries).toHaveLength(1);
            const query = result.queries[0] as Query;
            expect(query.name).toBe("GetOrderDetails");
            expect(query.messageType).toBe("query");
        });

        it("should not parse default decorators when custom decorators are specified", () => {
            // Arrange: Source with default @PublicEvent() decorator
            const sourceCode = `
        import { Message } from '@hexaijs/core';

        @PublicEvent()
        export class OrderPlaced extends Message<{
          orderId: string;
        }> {}
      `;

            // Act: Parser with custom decoratorNames should NOT find @PublicEvent
            const customDecoratorNames: DecoratorNames = {
                event: "ContractEvent",
                command: "ContractCommand",
                query: "ContractQuery",
            };
            const parser = new Parser({ decoratorNames: customDecoratorNames });
            const result = parser.parse(sourceCode, testSourceFile);

            // Assert: Should not find any events (since looking for @ContractEvent, not @PublicEvent)
            expect(result.events).toHaveLength(0);
        });

        it("should use default decorators when decoratorNames is not provided", () => {
            // Arrange: Source with default @PublicEvent() decorator
            const sourceCode = `
        import { Message } from '@hexaijs/core';

        @PublicEvent()
        export class OrderPlaced extends Message<{
          orderId: string;
        }> {}
      `;

            // Act: Parser without options should use default decorator names
            const parser = new Parser();
            const result = parser.parse(sourceCode, testSourceFile);

            // Assert: Should find the event with default decorator
            expect(result.events).toHaveLength(1);
            expect(result.events[0].name).toBe("OrderPlaced");
        });
    });

    describe("response type extraction", () => {
        describe("explicit response option", () => {
            it("should extract resultType from @PublicCommand({ response: 'TypeName' })", () => {
                const sourceCode = `
        import { Request } from '@hexaijs/core';

        @PublicCommand({ response: 'CreateUserResult' })
        export class CreateUser extends Request<CreateUserResult> {}

        export type CreateUserResult = {
          userId: string;
        };
      `;

                const parser = new Parser();
                const result = parser.parse(sourceCode, testSourceFile);

                expect(result.commands).toHaveLength(1);
                const command = result.commands[0] as Command;
                expect(command.name).toBe("CreateUser");
                expect(command.resultType).toBeDefined();
                expect((command.resultType as ReferenceType).kind).toBe(
                    "reference"
                );
                expect((command.resultType as ReferenceType).name).toBe(
                    "CreateUserResult"
                );
            });

            it("should extract resultType from @PublicQuery({ response: 'TypeName' })", () => {
                const sourceCode = `
        import { Request } from '@hexaijs/core';

        @PublicQuery({ response: 'UserProfile' })
        export class GetUserProfile extends Request<UserProfile> {}

        export type UserProfile = {
          name: string;
          email: string;
        };
      `;

                const parser = new Parser();
                const result = parser.parse(sourceCode, testSourceFile);

                expect(result.queries).toHaveLength(1);
                const query = result.queries[0] as Query;
                expect(query.name).toBe("GetUserProfile");
                expect(query.resultType).toBeDefined();
                expect((query.resultType as ReferenceType).kind).toBe(
                    "reference"
                );
                expect((query.resultType as ReferenceType).name).toBe(
                    "UserProfile"
                );
            });

            it("should not set resultType when response option is not provided", () => {
                const sourceCode = `
        import { Request } from '@hexaijs/core';

        @PublicCommand()
        export class CreateUser extends Request<void> {}
      `;

                const parser = new Parser();
                const result = parser.parse(sourceCode, testSourceFile);

                expect(result.commands).toHaveLength(1);
                const command = result.commands[0] as Command;
                expect(command.resultType).toBeUndefined();
            });
        });
    });

    describe("type definition extraction", () => {
        describe("type aliases", () => {
            it("should extract exported type alias from the same file", () => {
                const sourceCode = `
        import { Request } from '@hexaijs/core';

        export type CreateUserResult = {
          userId: string;
        };

        @PublicCommand()
        export class CreateUser extends Request<CreateUserResult> {}
      `;

                const parser = new Parser();
                const result = parser.parse(sourceCode, testSourceFile);

                expect(result.typeDefinitions).toBeDefined();
                expect(result.typeDefinitions).toHaveLength(1);

                const typeDef = result.typeDefinitions[0] as TypeDefinition;
                expect(typeDef.name).toBe("CreateUserResult");
                expect(typeDef.kind).toBe("type");
                expect(typeDef.exported).toBe(true);
                expect(typeDef.sourceFile).toEqual(testSourceFile);
            });

            it("should extract non-exported type alias", () => {
                const sourceCode = `
        import { Request } from '@hexaijs/core';

        type InternalPayload = {
          data: string;
        };

        @PublicCommand()
        export class ProcessData extends Request<InternalPayload> {}
      `;

                const parser = new Parser();
                const result = parser.parse(sourceCode, testSourceFile);

                expect(result.typeDefinitions).toHaveLength(1);
                const typeDef = result.typeDefinitions[0] as TypeDefinition;
                expect(typeDef.name).toBe("InternalPayload");
                expect(typeDef.exported).toBe(false);
            });

            it("should extract multiple type aliases from same file", () => {
                const sourceCode = `
        export type UserId = string;
        export type UserName = string;
        type InternalId = number;
      `;

                const parser = new Parser();
                const result = parser.parse(sourceCode, testSourceFile);

                expect(result.typeDefinitions).toHaveLength(3);

                const names = result.typeDefinitions.map((t) => t.name);
                expect(names).toContain("UserId");
                expect(names).toContain("UserName");
                expect(names).toContain("InternalId");
            });
        });

        describe("interfaces", () => {
            it("should extract exported interface", () => {
                const sourceCode = `
        export interface UserProfile {
          name: string;
          email: string;
        }
      `;

                const parser = new Parser();
                const result = parser.parse(sourceCode, testSourceFile);

                expect(result.typeDefinitions).toHaveLength(1);
                const typeDef = result.typeDefinitions[0] as TypeDefinition;
                expect(typeDef.name).toBe("UserProfile");
                expect(typeDef.kind).toBe("interface");
                expect(typeDef.exported).toBe(true);
            });

            it("should extract non-exported interface", () => {
                const sourceCode = `
        interface InternalConfig {
          timeout: number;
        }
      `;

                const parser = new Parser();
                const result = parser.parse(sourceCode, testSourceFile);

                expect(result.typeDefinitions).toHaveLength(1);
                const typeDef = result.typeDefinitions[0] as TypeDefinition;
                expect(typeDef.name).toBe("InternalConfig");
                expect(typeDef.kind).toBe("interface");
                expect(typeDef.exported).toBe(false);
            });
        });

        describe("composite types", () => {
            it("should extract composite type and its body should contain referenced types", () => {
                const sourceCode = `
        type BasePayload = {
          id: string;
        };

        type TimestampMixin = {
          createdAt: Date;
        };

        export type CompositePayload = BasePayload & TimestampMixin;
      `;

                const parser = new Parser();
                const result = parser.parse(sourceCode, testSourceFile);

                expect(result.typeDefinitions).toHaveLength(3);

                const composite = result.typeDefinitions.find(
                    (t) => t.name === "CompositePayload"
                );
                expect(composite).toBeDefined();
                expect(composite!.kind).toBe("type");

                // The body should be an intersection type referencing BasePayload and TimestampMixin
                expect(composite!.body.kind).toBe("intersection");
                const intersectionBody = composite!.body as IntersectionType;
                expect(intersectionBody.types).toHaveLength(2);

                const refNames = intersectionBody.types
                    .filter((t): t is ReferenceType => t.kind === "reference")
                    .map((t) => t.name);
                expect(refNames).toContain("BasePayload");
                expect(refNames).toContain("TimestampMixin");
            });

            it("should extract all components of intersection type A & B & C", () => {
                const sourceCode = `
        type A = { a: string };
        type B = { b: number };
        type C = { c: boolean };
        export type Combined = A & B & C;
      `;

                const parser = new Parser();
                const result = parser.parse(sourceCode, testSourceFile);

                expect(result.typeDefinitions).toHaveLength(4);

                const combined = result.typeDefinitions.find(
                    (t) => t.name === "Combined"
                );
                expect(combined!.body.kind).toBe("intersection");

                const intersection = combined!.body as IntersectionType;
                expect(intersection.types).toHaveLength(3);
            });
        });

        describe("type body parsing", () => {
            it("should parse object type body correctly", () => {
                const sourceCode = `
        export type UserData = {
          id: string;
          age: number;
          active: boolean;
        };
      `;

                const parser = new Parser();
                const result = parser.parse(sourceCode, testSourceFile);

                const typeDef = result.typeDefinitions[0];
                expect(typeDef.body.kind).toBe("object");

                const objectBody = typeDef.body as ObjectType;
                expect(objectBody.fields).toHaveLength(3);
                expect(objectBody.fields[0].name).toBe("id");
                expect(objectBody.fields[1].name).toBe("age");
                expect(objectBody.fields[2].name).toBe("active");
            });

            it("should parse reference type body (type alias to another type)", () => {
                const sourceCode = `
        type UserId = string;
        export type Id = UserId;
      `;

                const parser = new Parser();
                const result = parser.parse(sourceCode, testSourceFile);

                const idType = result.typeDefinitions.find(
                    (t) => t.name === "Id"
                );
                expect(idType!.body.kind).toBe("reference");
                expect((idType!.body as ReferenceType).name).toBe("UserId");
            });
        });

        describe("mixed declarations", () => {
            it("should extract both type aliases and interfaces from same file", () => {
                const sourceCode = `
        import { Request } from '@hexaijs/core';

        export interface UserProfile {
          name: string;
        }

        export type CreateUserResult = {
          userId: string;
        };

        type InternalState = {
          loading: boolean;
        };

        @PublicCommand({ response: 'CreateUserResult' })
        export class CreateUser extends Request<void> {}
      `;

                const parser = new Parser();
                const result = parser.parse(sourceCode, testSourceFile);

                // Should have both messages and type definitions
                expect(result.commands).toHaveLength(1);
                expect(result.typeDefinitions).toHaveLength(3);

                const kinds = result.typeDefinitions.map((t) => t.kind);
                expect(kinds).toContain("interface");
                expect(kinds).toContain("type");
            });
        });
    });

    describe("naming convention matching", () => {
        describe("basic convention matching", () => {
            it("should match resultType by naming convention for Command", () => {
                const sourceCode = `
        import { Request } from '@hexaijs/core';

        @PublicCommand()
        export class CreateUserCommand extends Request<void> {}

        export type CreateUserCommandResult = {
          userId: string;
        };
      `;

                const parser = new Parser({
                    responseNamingConventions: [
                        {
                            messageSuffix: "Command",
                            responseSuffix: "CommandResult",
                        },
                    ],
                });
                const result = parser.parse(sourceCode, testSourceFile);

                expect(result.commands).toHaveLength(1);
                const command = result.commands[0] as Command;
                expect(command.name).toBe("CreateUserCommand");
                expect(command.resultType).toBeDefined();
                expect((command.resultType as ReferenceType).kind).toBe(
                    "reference"
                );
                expect((command.resultType as ReferenceType).name).toBe(
                    "CreateUserCommandResult"
                );
            });

            it("should match resultType by naming convention for Query", () => {
                const sourceCode = `
        import { Request } from '@hexaijs/core';

        @PublicQuery()
        export class GetUserQuery extends Request<void> {}

        export type GetUserQueryResult = {
          name: string;
          email: string;
        };
      `;

                const parser = new Parser({
                    responseNamingConventions: [
                        {
                            messageSuffix: "Query",
                            responseSuffix: "QueryResult",
                        },
                    ],
                });
                const result = parser.parse(sourceCode, testSourceFile);

                expect(result.queries).toHaveLength(1);
                const query = result.queries[0] as Query;
                expect(query.name).toBe("GetUserQuery");
                expect(query.resultType).toBeDefined();
                expect((query.resultType as ReferenceType).kind).toBe(
                    "reference"
                );
                expect((query.resultType as ReferenceType).name).toBe(
                    "GetUserQueryResult"
                );
            });
        });

        describe("multiple conventions", () => {
            it("should try conventions in order and use first match", () => {
                const sourceCode = `
        import { Request } from '@hexaijs/core';

        @PublicCommand()
        export class CreateUserCommand extends Request<void> {}

        export type CreateUserResult = {
          userId: string;
        };
      `;

                const parser = new Parser({
                    responseNamingConventions: [
                        {
                            messageSuffix: "Command",
                            responseSuffix: "CommandResult",
                        },
                        { messageSuffix: "Command", responseSuffix: "Result" },
                    ],
                });
                const result = parser.parse(sourceCode, testSourceFile);

                expect(result.commands).toHaveLength(1);
                const command = result.commands[0] as Command;
                // Should match CreateUserResult (second convention) since CreateUserCommandResult doesn't exist
                expect(command.resultType).toBeDefined();
                expect((command.resultType as ReferenceType).name).toBe(
                    "CreateUserResult"
                );
            });
        });

        describe("no match scenarios", () => {
            it("should not set resultType when no matching type exists", () => {
                const sourceCode = `
        import { Request } from '@hexaijs/core';

        @PublicCommand()
        export class CreateUserCommand extends Request<void> {}
      `;

                const parser = new Parser({
                    responseNamingConventions: [
                        {
                            messageSuffix: "Command",
                            responseSuffix: "CommandResult",
                        },
                    ],
                });
                const result = parser.parse(sourceCode, testSourceFile);

                expect(result.commands).toHaveLength(1);
                const command = result.commands[0] as Command;
                // No matching type, so resultType should be undefined
                expect(command.resultType).toBeUndefined();
            });

            it("should not set resultType when message name doesn't end with convention suffix", () => {
                const sourceCode = `
        import { Request } from '@hexaijs/core';

        @PublicCommand()
        export class CreateUser extends Request<void> {}

        export type CreateUserResult = {
          userId: string;
        };
      `;

                const parser = new Parser({
                    responseNamingConventions: [
                        {
                            messageSuffix: "Command",
                            responseSuffix: "CommandResult",
                        },
                    ],
                });
                const result = parser.parse(sourceCode, testSourceFile);

                expect(result.commands).toHaveLength(1);
                const command = result.commands[0] as Command;
                // CreateUser doesn't end with "Command", so convention doesn't apply
                expect(command.resultType).toBeUndefined();
            });
        });

        describe("explicit response takes precedence", () => {
            it("should use explicit response option over naming convention", () => {
                const sourceCode = `
        import { Request } from '@hexaijs/core';

        @PublicCommand({ response: 'ExplicitResult' })
        export class CreateUserCommand extends Request<void> {}

        export type CreateUserCommandResult = {
          userId: string;
        };

        export type ExplicitResult = {
          explicit: boolean;
        };
      `;

                const parser = new Parser({
                    responseNamingConventions: [
                        {
                            messageSuffix: "Command",
                            responseSuffix: "CommandResult",
                        },
                    ],
                });
                const result = parser.parse(sourceCode, testSourceFile);

                expect(result.commands).toHaveLength(1);
                const command = result.commands[0] as Command;
                // Explicit response should take precedence
                expect(command.resultType).toBeDefined();
                expect((command.resultType as ReferenceType).name).toBe(
                    "ExplicitResult"
                );
            });
        });

        describe("Request suffix conventions", () => {
            it("should match Request → Response convention", () => {
                const sourceCode = `
        import { Request } from '@hexaijs/core';

        @PublicCommand()
        export class BeginDialogueRequest extends Request<void> {}

        export type BeginDialogueResponse = {
          dialogueId: string;
        };
      `;

                const parser = new Parser({
                    responseNamingConventions: [
                        {
                            messageSuffix: "Request",
                            responseSuffix: "Response",
                        },
                    ],
                });
                const result = parser.parse(sourceCode, testSourceFile);

                expect(result.commands).toHaveLength(1);
                const command = result.commands[0] as Command;
                expect(command.resultType).toBeDefined();
                expect((command.resultType as ReferenceType).name).toBe(
                    "BeginDialogueResponse"
                );
            });
        });

        describe("interface matching", () => {
            it("should match interface as response type", () => {
                const sourceCode = `
        import { Request } from '@hexaijs/core';

        @PublicQuery()
        export class GetUserQuery extends Request<void> {}

        export interface GetUserQueryResult {
          name: string;
          email: string;
        }
      `;

                const parser = new Parser({
                    responseNamingConventions: [
                        {
                            messageSuffix: "Query",
                            responseSuffix: "QueryResult",
                        },
                    ],
                });
                const result = parser.parse(sourceCode, testSourceFile);

                expect(result.queries).toHaveLength(1);
                const query = result.queries[0] as Query;
                expect(query.resultType).toBeDefined();
                expect((query.resultType as ReferenceType).name).toBe(
                    "GetUserQueryResult"
                );
            });
        });
    });
});
