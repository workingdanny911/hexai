import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { E2ETestContext, importGeneratedModule } from "../helpers";

describe("Runtime: Complex Types", () => {
    const ctx = new E2ETestContext("complex-types");

    beforeAll(async () => {
        await ctx.setup();
        await ctx.runParser();
    });

    afterAll(async () => {
        await ctx.teardown();
    });

    describe("CreateUser Command", () => {
        it("should handle optional fields", async () => {
            const { CreateUser } = await importGeneratedModule<{
                CreateUser: new (payload: Record<string, unknown>) => {
                    getPayload(): Record<string, unknown>;
                };
            }>(ctx.getOutputFile("complex-types", "commands.ts"));

            const cmdMinimal = new CreateUser({
                name: "John Doe",
                email: "john@example.com",
            });

            const minimalPayload = cmdMinimal.getPayload();
            expect(minimalPayload.name).toBe("John Doe");
            expect(minimalPayload.email).toBe("john@example.com");
            expect(minimalPayload.contact).toBeUndefined();
            expect(minimalPayload.initialRoles).toBeUndefined();

            const cmdFull = new CreateUser({
                name: "Jane Doe",
                email: "jane@example.com",
                contact: {
                    email: "jane@work.com",
                    phone: "123-456-7890",
                    address: {
                        street: "123 Main St",
                        city: "Seoul",
                        country: "Korea",
                    },
                },
                initialRoles: ["admin", "user"],
                initialStatus: "active",
            });

            const fullPayload = cmdFull.getPayload();
            expect(fullPayload.contact).toBeDefined();
            expect(fullPayload.initialRoles).toEqual(["admin", "user"]);
        });
    });

    describe("SearchUsers Command", () => {
        it("should handle pagination params and filters", async () => {
            const { SearchUsers } = await importGeneratedModule<{
                SearchUsers: new (payload: Record<string, unknown>) => {
                    getPayload(): Record<string, unknown>;
                };
            }>(ctx.getOutputFile("complex-types", "commands.ts"));

            const cmd = new SearchUsers({
                page: 1,
                pageSize: 20,
                sortBy: "createdAt",
                sortOrder: "desc",
                filters: {
                    status: ["active", "pending"],
                    roles: ["admin"],
                    createdAfter: Date.now() - 86400000,
                },
                includeDeleted: false,
            });

            const payload = cmd.getPayload();
            expect(payload.page).toBe(1);
            expect(payload.pageSize).toBe(20);
            expect(payload.filters).toBeDefined();
        });
    });

    describe("BatchUpdateStatus Command", () => {
        it("should handle array of IDs", async () => {
            const { BatchUpdateStatus } = await importGeneratedModule<{
                BatchUpdateStatus: new (payload: Record<string, unknown>) => {
                    getPayload(): { userIds: string[]; newStatus: string };
                };
            }>(ctx.getOutputFile("complex-types", "commands.ts"));

            const cmd = new BatchUpdateStatus({
                userIds: ["user-1", "user-2", "user-3"],
                newStatus: "suspended",
                reason: "Policy violation",
                notifyUsers: true,
            });

            const payload = cmd.getPayload();
            expect(payload.userIds).toHaveLength(3);
            expect(payload.newStatus).toBe("suspended");
        });
    });

    describe("UserCreated Event", () => {
        it("should handle nested UserProfile type", async () => {
            const { UserCreated } = await importGeneratedModule<{
                UserCreated: new (payload: Record<string, unknown>) => {
                    getPayload(): { profile: Record<string, unknown> };
                };
            }>(ctx.getOutputFile("complex-types", "events.ts"));

            const event = new UserCreated({
                createdAt: Date.now(),
                createdBy: "system",
                profile: {
                    id: "user-123",
                    name: "Test User",
                    contact: {
                        email: "test@example.com",
                    },
                    status: "active",
                    roles: ["user"],
                    permissions: [],
                },
            });

            const payload = event.getPayload();
            expect(payload.profile).toBeDefined();
            expect((payload.profile as Record<string, unknown>).id).toBe("user-123");
        });
    });

    describe("NestedDataProcessed Event", () => {
        it("should handle deeply nested types", async () => {
            const { NestedDataProcessed } = await importGeneratedModule<{
                NestedDataProcessed: new (payload: Record<string, unknown>) => {
                    getPayload(): {
                        nested: {
                            level1: {
                                level2: {
                                    level3: { value: string };
                                };
                            };
                        };
                    };
                };
            }>(ctx.getOutputFile("complex-types", "events.ts"));

            const event = new NestedDataProcessed({
                id: "nested-1",
                nested: {
                    level1: {
                        level2: {
                            level3: {
                                value: "deep value",
                            },
                        },
                    },
                },
                flatValue: "surface",
            });

            const payload = event.getPayload();
            expect(payload.nested.level1.level2.level3.value).toBe("deep value");
        });
    });

    describe("BatchUsersProcessed Event", () => {
        it("should handle array and summary object", async () => {
            const { BatchUsersProcessed } = await importGeneratedModule<{
                BatchUsersProcessed: new (payload: Record<string, unknown>) => {
                    getPayload(): {
                        users: unknown[];
                        summary: {
                            total: number;
                            succeeded: number;
                            failed: number;
                            errors?: Array<{ userId: string; error: string }>;
                        };
                    };
                };
            }>(ctx.getOutputFile("complex-types", "events.ts"));

            const event = new BatchUsersProcessed({
                batchId: "batch-1",
                users: [
                    { id: "user-1", name: "User 1" },
                    { id: "user-2", name: "User 2" },
                ],
                processedAt: Date.now(),
                summary: {
                    total: 2,
                    succeeded: 1,
                    failed: 1,
                    errors: [{ userId: "user-2", error: "Invalid data" }],
                },
            });

            const payload = event.getPayload();
            expect(payload.users).toHaveLength(2);
            expect(payload.summary.total).toBe(2);
            expect(payload.summary.succeeded).toBe(1);
            expect(payload.summary.failed).toBe(1);
            expect(payload.summary.errors).toHaveLength(1);
        });
    });

    describe("UserStatusChanged Event", () => {
        it("should handle status union types", async () => {
            const { UserStatusChanged } = await importGeneratedModule<{
                UserStatusChanged: new (payload: Record<string, unknown>) => {
                    getPayload(): {
                        previousStatus: string;
                        newStatus: string;
                    };
                };
            }>(ctx.getOutputFile("complex-types", "events.ts"));

            const event = new UserStatusChanged({
                userId: "user-1",
                previousStatus: "pending",
                newStatus: "active",
                changedAt: Date.now(),
                changedBy: "admin-1",
            });

            const payload = event.getPayload();
            expect(payload.previousStatus).toBe("pending");
            expect(payload.newStatus).toBe("active");
        });
    });

    describe("Module exports", () => {
        it("should export all classes from index.ts", async () => {
            const module = await importGeneratedModule<Record<string, unknown>>(
                ctx.getOutputFile("complex-types", "index.ts")
            );

            expect(module.CreateUser).toBeDefined();
            expect(module.UpdateUserRoles).toBeDefined();
            expect(module.UpdateUserAddress).toBeDefined();
            expect(module.SearchUsers).toBeDefined();
            expect(module.BatchUpdateStatus).toBeDefined();
            expect(module.UserCreated).toBeDefined();
            expect(module.UserStatusChanged).toBeDefined();
            expect(module.UserRolesUpdated).toBeDefined();
            expect(module.UserAddressUpdated).toBeDefined();
            expect(module.NestedDataProcessed).toBeDefined();
            expect(module.BatchUsersProcessed).toBeDefined();
        });
    });
});
