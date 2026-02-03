import { describe, expect, expectTypeOf, it } from "vitest";

import { AbstractApplicationContext } from "@/abstract-application-context";
import { ApplicationBuilder, SuccessResult } from "@/application";
import { Command } from "@/command";
import { Query } from "@/query";
import { expectSuccessResult } from "@/test";

class TestApplicationContext extends AbstractApplicationContext {}

describe("Application type inference", () => {
    describe("executeCommand", () => {
        it("returns correctly typed result", async () => {
            class CreateUser extends Command<{ name: string }, { id: string }> {
                constructor(name: string) {
                    super({ name });
                }
            }

            const handler = {
                execute: async (cmd: CreateUser): Promise<{ id: string }> => {
                    return { id: `user-${cmd.getPayload().name}` };
                },
            };

            const app = new ApplicationBuilder()
                .withApplicationContext(new TestApplicationContext())
                .withCommandHandler(CreateUser, () => handler)
                .build();

            const result = await app.executeCommand(new CreateUser("John"));

            expectSuccessResult(result);
            expect(result.data).toEqual({ id: "user-John" });
        });

        it("handles void output command", async () => {
            class DeleteUser extends Command<{ id: string }, void> {
                constructor(id: string) {
                    super({ id });
                }
            }

            const handler = {
                execute: async (_cmd: DeleteUser): Promise<void> => {
                    // deletion logic
                },
            };

            const app = new ApplicationBuilder()
                .withApplicationContext(new TestApplicationContext())
                .withCommandHandler(DeleteUser, () => handler)
                .build();

            const result = await app.executeCommand(new DeleteUser("user-1"));

            expectSuccessResult(result);
        });

        it("preserves complex output types", async () => {
            interface UserProfile {
                id: string;
                name: string;
                metadata: { createdAt: Date };
            }

            class CreateUserWithProfile extends Command<
                { name: string },
                UserProfile
            > {
                constructor(name: string) {
                    super({ name });
                }
            }

            const handler = {
                execute: async (
                    cmd: CreateUserWithProfile
                ): Promise<UserProfile> => {
                    return {
                        id: "user-123",
                        name: cmd.getPayload().name,
                        metadata: { createdAt: new Date() },
                    };
                },
            };

            const app = new ApplicationBuilder()
                .withApplicationContext(new TestApplicationContext())
                .withCommandHandler(CreateUserWithProfile, () => handler)
                .build();

            const result = await app.executeCommand(
                new CreateUserWithProfile("John")
            );

            expectSuccessResult(result);
        });
    });

    describe("executeQuery", () => {
        it("returns correctly typed result", async () => {
            class GetUsers extends Query<
                { filter: string },
                { users: string[] }
            > {
                constructor(filter: string) {
                    super({ filter });
                }
            }

            const handler = {
                execute: async (
                    query: GetUsers
                ): Promise<{ users: string[] }> => {
                    return { users: [`user-${query.getPayload().filter}`] };
                },
            };

            const app = new ApplicationBuilder()
                .withApplicationContext(new TestApplicationContext())
                .withQueryHandler(GetUsers, () => handler)
                .build();

            const result = await app.executeQuery(new GetUsers("active"));

            expectSuccessResult(result);
            expect(result.data).toEqual({ users: ["user-active"] });
        });

        it("handles paginated output types", async () => {
            interface PaginatedResult<T> {
                items: T[];
                total: number;
                page: number;
            }

            interface Product {
                id: string;
                name: string;
            }

            class ListProducts extends Query<
                { page: number },
                PaginatedResult<Product>
            > {
                constructor(page: number) {
                    super({ page });
                }
            }

            const handler = {
                execute: async (
                    query: ListProducts
                ): Promise<PaginatedResult<Product>> => {
                    return {
                        items: [{ id: "p1", name: "Product 1" }],
                        total: 1,
                        page: query.getPayload().page,
                    };
                },
            };

            const app = new ApplicationBuilder()
                .withApplicationContext(new TestApplicationContext())
                .withQueryHandler(ListProducts, () => handler)
                .build();

            const result = await app.executeQuery(new ListProducts(1));

            expectSuccessResult(result);
            expect(result.data.page).toBe(1);
        });
    });

    describe("type utilities", () => {
        it("ResultType extracts output type from Command", () => {
            class MyCommand extends Command<
                { input: string },
                { output: number }
            > {
                constructor(input: string) {
                    super({ input });
                }
            }

            type Output = MyCommand['ResultType'];
            expectTypeOf<Output>().toEqualTypeOf<{ output: number }>();
        });

        it("ResultType extracts output type from Query", () => {
            class MyQuery extends Query<{ input: string }, { output: number }> {
                constructor(input: string) {
                    super({ input });
                }
            }

            type Output = MyQuery['ResultType'];
            expectTypeOf<Output>().toEqualTypeOf<{ output: number }>();
        });
    });

    describe("handler return type constraint", () => {
        it("handler can return SuccessResult wrapping output type", async () => {
            class GetData extends Query<null, { data: string }> {
                constructor() {
                    super(null);
                }
            }

            const handler = {
                execute: async (
                    _query: GetData
                ): Promise<SuccessResult<{ data: string }>> => {
                    return new SuccessResult({ data: "result" });
                },
            };

            const app = new ApplicationBuilder()
                .withApplicationContext(new TestApplicationContext())
                .withQueryHandler(GetData, () => handler)
                .build();

            const result = await app.executeQuery(new GetData());

            expectSuccessResult(result);
            expect(result.data).toBeInstanceOf(SuccessResult);
        });

        it("handler can return plain output type", async () => {
            class GetData extends Query<null, { data: string }> {
                constructor() {
                    super(null);
                }
            }

            const handler = {
                execute: async (_query: GetData): Promise<{ data: string }> => {
                    return { data: "result" };
                },
            };

            const app = new ApplicationBuilder()
                .withApplicationContext(new TestApplicationContext())
                .withQueryHandler(GetData, () => handler)
                .build();

            const result = await app.executeQuery(new GetData());

            expectSuccessResult(result);
            expect(result.data).toEqual({ data: "result" });
        });
    });
});
