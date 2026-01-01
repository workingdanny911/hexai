import { describe, expect, it } from "vitest";
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

    describe("withHeader", () => {
        it("should set header and return new instance", () => {
            const query1 = new TestQuery("hello");
            const query2 = query1.withHeader("correlationId", "corr-123");

            expect(query1.getHeader("correlationId")).toBeUndefined();
            expect(query2.getHeader("correlationId")).toBe("corr-123");
        });

        it("should chain multiple withHeader calls", () => {
            const query = new TestQuery("hello")
                .withHeader("correlationId", "corr-123")
                .withHeader("correlationType", "HttpRequest");

            expect(query.getHeader("correlationId")).toBe("corr-123");
            expect(query.getHeader("correlationType")).toBe("HttpRequest");
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

        it("should chain withSecurityContext with withHeader", () => {
            const securityContext = { userId: "user-456" };

            const query = new TestQuery("hello")
                .withSecurityContext(securityContext)
                .withHeader("correlationId", "corr-789");

            expect(query.getSecurityContext()).toEqual(securityContext);
            expect(query.getHeader("correlationId")).toBe("corr-789");
        });
    });
});
