import { describe, expect, expectTypeOf, it } from "vitest";
import { Query } from "./query";

class TestQuery extends Query<{ value: string }> {
    constructor(value: string = "test") {
        super({ value });
    }
}

describe("Query", () => {
    describe("intent", () => {
        it("should have intent 'query' in headers", () => {
            const query = new TestQuery("hello");

            expect(query.getHeader("intent")).toBe("query");
        });

        it("should include intent in serialized output", () => {
            const query = new TestQuery("hello");
            const serialized = query.serialize();

            expect(serialized.headers.intent).toBe("query");
        });
    });

    describe("withCorrelation", () => {
        it("should set correlation and return new instance", () => {
            const query1 = new TestQuery("hello");
            const query2 = query1.withCorrelation({ id: "corr-123", type: "HttpRequest" });

            expect(query1.getCorrelation()).toBeUndefined();
            expect(query2.getCorrelation()).toEqual({ id: "corr-123", type: "HttpRequest" });
        });

        it("should chain withCorrelation with withCausation", () => {
            const query = new TestQuery("hello")
                .withCorrelation({ id: "corr-123", type: "HttpRequest" })
                .withCausation({ id: "cause-456", type: "UserAction" });

            expect(query.getCorrelation()).toEqual({ id: "corr-123", type: "HttpRequest" });
            expect(query.getCausation()).toEqual({ id: "cause-456", type: "UserAction" });
        });
    });

    describe("withSecurityContext", () => {
        it("should set security context and return new instance", () => {
            const securityContext = { userId: "user-123", roles: ["admin"] };
            const query1 = new TestQuery("hello");

            const query2 = query1.withSecurityContext(securityContext);

            expect(() => query1.getSecurityContext()).toThrow(
                "security context is not set"
            );
            expect(query2.getSecurityContext()).toEqual(securityContext);
        });

        it("should chain withSecurityContext with withCorrelation", () => {
            const securityContext = { userId: "user-456" };

            const query = new TestQuery("hello")
                .withSecurityContext(securityContext)
                .withCorrelation({ id: "corr-789", type: "HttpRequest" });

            expect(query.getSecurityContext()).toEqual(securityContext);
            expect(query.getCorrelation()).toEqual({ id: "corr-789", type: "HttpRequest" });
        });

        it("should return typed security context with generic", () => {
            interface MySecurityContext {
                userId: string;
                permissions: string[];
            }

            const sc: MySecurityContext = {
                userId: "u1",
                permissions: ["read", "write"],
            };
            const query = new TestQuery("test").withSecurityContext(sc);

            const retrieved = query.getSecurityContext<MySecurityContext>();

            expect(retrieved.userId).toBe("u1");
            expect(retrieved.permissions).toEqual(["read", "write"]);
            expectTypeOf(retrieved).toEqualTypeOf<MySecurityContext>();
        });
    });

    describe("ResultType indexed access", () => {
        it("extracts output type from Query", () => {
            class GetUsers extends Query<{ filter: string }, { users: string[] }> {
                constructor(filter: string) {
                    super({ filter });
                }
            }

            type Output = GetUsers['ResultType'];

            expectTypeOf<Output>().toEqualTypeOf<{ users: string[] }>();
        });

        it("returns void for void output Query", () => {
            class CheckHealth extends Query<null, void> {
                constructor() {
                    super(null);
                }
            }

            type Output = CheckHealth['ResultType'];

            expectTypeOf<Output>().toEqualTypeOf<void>();
        });

        it("returns unknown for Query without explicit output", () => {
            class GenericQuery extends Query<{ id: string }> {
                constructor(id: string) {
                    super({ id });
                }
            }

            type Output = GenericQuery['ResultType'];

            expectTypeOf<Output>().toEqualTypeOf<unknown>();
        });

        it("works with complex output types", () => {
            interface PaginatedResult<T> {
                items: T[];
                total: number;
                page: number;
            }

            class ListProducts extends Query<
                { page: number },
                PaginatedResult<{ id: string; name: string }>
            > {
                constructor(page: number) {
                    super({ page });
                }
            }

            type Output = ListProducts['ResultType'];

            expectTypeOf<Output>().toEqualTypeOf<
                PaginatedResult<{ id: string; name: string }>
            >();
        });
    });
});
