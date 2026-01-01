import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PostgresConfig } from "./postgres-config";

describe("PostgresConfig", () => {
    describe("constructor", () => {
        it("should create config with required database field", () => {
            const config = new PostgresConfig({ database: "testdb" });

            expect(config.database).toBe("testdb");
            expect(config.host).toBe("localhost");
            expect(config.port).toBe(5432);
            expect(config.user).toBe("postgres");
            expect(config.password).toBeUndefined();
        });

        it("should create config with all fields", () => {
            const config = new PostgresConfig({
                database: "mydb",
                host: "dbhost",
                port: 5433,
                user: "admin",
                password: "secret",
            });

            expect(config.database).toBe("mydb");
            expect(config.host).toBe("dbhost");
            expect(config.port).toBe(5433);
            expect(config.user).toBe("admin");
            expect(config.password).toBe("secret");
        });

        it("should create config with pool options", () => {
            const config = new PostgresConfig({
                database: "testdb",
                pool: { size: 10, connectionTimeout: 5000, idleTimeout: 30000 },
            });

            expect(config.pool).toEqual({
                size: 10,
                connectionTimeout: 5000,
                idleTimeout: 30000,
            });
        });
    });

    describe("fromUrl", () => {
        it("should parse postgres URL", () => {
            const config = PostgresConfig.fromUrl(
                "postgres://user:pass@localhost:5432/mydb"
            );

            expect(config.host).toBe("localhost");
            expect(config.port).toBe(5432);
            expect(config.database).toBe("mydb");
            expect(config.user).toBe("user");
            expect(config.password).toBe("pass");
        });

        it("should parse postgresql URL (alias)", () => {
            const config = PostgresConfig.fromUrl(
                "postgresql://user:pass@localhost:5432/mydb"
            );

            expect(config.host).toBe("localhost");
            expect(config.database).toBe("mydb");
        });

        it("should parse URL without password", () => {
            const config = PostgresConfig.fromUrl(
                "postgres://user@localhost:5432/mydb"
            );

            expect(config.user).toBe("user");
            expect(config.password).toBeUndefined();
        });

        it("should use default port when not specified", () => {
            const config = PostgresConfig.fromUrl(
                "postgres://user:pass@localhost/mydb"
            );

            expect(config.port).toBe(5432);
        });

        it("should throw error for invalid URL", () => {
            expect(() => PostgresConfig.fromUrl("invalid-url")).toThrowError(
                "Invalid postgres url"
            );
        });
    });

    describe("fromEnv", () => {
        const originalEnv = process.env;

        beforeEach(() => {
            vi.resetModules();
            process.env = { ...originalEnv };
        });

        afterEach(() => {
            process.env = originalEnv;
        });

        describe("url mode (default)", () => {
            it("should load from {PREFIX}_URL environment variable", () => {
                process.env.ASSIGNMENT_DB_URL =
                    "postgres://user:pass@localhost:5432/assignmentdb";

                const config = PostgresConfig.fromEnv("ASSIGNMENT_DB");

                expect(config.database).toBe("assignmentdb");
                expect(config.user).toBe("user");
                expect(config.host).toBe("localhost");
            });

            it("should throw error when URL environment variable is not set", () => {
                expect(() => PostgresConfig.fromEnv("MISSING_DB")).toThrowError(
                    "Environment variable MISSING_DB_URL is not set"
                );
            });
        });

        describe("fields mode", () => {
            it("should load from individual environment variables", () => {
                process.env.POSTGRES_DATABASE = "testdb";
                process.env.POSTGRES_HOST = "dbhost";
                process.env.POSTGRES_PORT = "5433";
                process.env.POSTGRES_USER = "admin";
                process.env.POSTGRES_PASSWORD = "secret";

                const config = PostgresConfig.fromEnv("POSTGRES", {
                    mode: "fields",
                });

                expect(config.database).toBe("testdb");
                expect(config.host).toBe("dbhost");
                expect(config.port).toBe(5433);
                expect(config.user).toBe("admin");
                expect(config.password).toBe("secret");
            });

            it("should use defaults when optional fields are not set", () => {
                process.env.POSTGRES_DATABASE = "testdb";

                const config = PostgresConfig.fromEnv("POSTGRES", {
                    mode: "fields",
                });

                expect(config.database).toBe("testdb");
                expect(config.host).toBe("localhost");
                expect(config.port).toBe(5432);
                expect(config.user).toBe("postgres");
            });

            it("should throw error when DATABASE is not set", () => {
                expect(() =>
                    PostgresConfig.fromEnv("MISSING", { mode: "fields" })
                ).toThrowError("Environment variable MISSING_DATABASE is not set");
            });
        });
    });

    describe("builder methods (immutability)", () => {
        it("withDatabase should return new instance", () => {
            const original = new PostgresConfig({ database: "original" });
            const modified = original.withDatabase("modified");

            expect(modified).not.toBe(original);
            expect(modified.database).toBe("modified");
            expect(original.database).toBe("original");
        });

        it("withUser should return new instance", () => {
            const original = new PostgresConfig({ database: "db" });
            const modified = original.withUser("newuser");

            expect(modified).not.toBe(original);
            expect(modified.user).toBe("newuser");
            expect(original.user).toBe("postgres");
        });

        it("withPassword should return new instance", () => {
            const original = new PostgresConfig({ database: "db" });
            const modified = original.withPassword("secret");

            expect(modified).not.toBe(original);
            expect(modified.password).toBe("secret");
            expect(original.password).toBeUndefined();
        });

        it("withHost should return new instance", () => {
            const original = new PostgresConfig({ database: "db" });
            const modified = original.withHost("newhost");

            expect(modified).not.toBe(original);
            expect(modified.host).toBe("newhost");
            expect(original.host).toBe("localhost");
        });

        it("withPort should return new instance", () => {
            const original = new PostgresConfig({ database: "db" });
            const modified = original.withPort(5433);

            expect(modified).not.toBe(original);
            expect(modified.port).toBe(5433);
            expect(original.port).toBe(5432);
        });

        it("should preserve pool options when using with* methods", () => {
            const original = new PostgresConfig({
                database: "db",
                pool: { size: 10 },
            });
            const modified = original.withDatabase("newdb");

            expect(modified.pool?.size).toBe(10);
        });

        it("should support method chaining", () => {
            const config = new PostgresConfig({ database: "db" })
                .withHost("newhost")
                .withPort(5433)
                .withUser("admin")
                .withPassword("secret");

            expect(config.host).toBe("newhost");
            expect(config.port).toBe(5433);
            expect(config.user).toBe("admin");
            expect(config.password).toBe("secret");
        });
    });

    describe("pool option methods", () => {
        it("withPoolSize should set pool size", () => {
            const config = new PostgresConfig({ database: "db" }).withPoolSize(
                20
            );

            expect(config.pool?.size).toBe(20);
        });

        it("withConnectionTimeout should set connection timeout", () => {
            const config = new PostgresConfig({
                database: "db",
            }).withConnectionTimeout(5000);

            expect(config.pool?.connectionTimeout).toBe(5000);
        });

        it("withIdleTimeout should set idle timeout", () => {
            const config = new PostgresConfig({
                database: "db",
            }).withIdleTimeout(30000);

            expect(config.pool?.idleTimeout).toBe(30000);
        });

        it("should preserve existing pool options when adding new ones", () => {
            const config = new PostgresConfig({ database: "db" })
                .withPoolSize(10)
                .withConnectionTimeout(5000)
                .withIdleTimeout(30000);

            expect(config.pool).toEqual({
                size: 10,
                connectionTimeout: 5000,
                idleTimeout: 30000,
            });
        });
    });

    describe("toString", () => {
        it("should serialize basic config to URL", () => {
            const config = new PostgresConfig({
                database: "mydb",
                host: "localhost",
                port: 5432,
                user: "postgres",
            });

            expect(config.toString()).toBe(
                "postgres://postgres@localhost:5432/mydb"
            );
        });

        it("should include password in URL", () => {
            const config = new PostgresConfig({
                database: "mydb",
                user: "user",
                password: "pass",
            });

            expect(config.toString()).toBe(
                "postgres://user:pass@localhost:5432/mydb"
            );
        });

        it("should serialize pool options as query params", () => {
            const config = new PostgresConfig({
                database: "mydb",
                user: "user",
                pool: { size: 10, connectionTimeout: 5000, idleTimeout: 30000 },
            });

            expect(config.toString()).toBe(
                "postgres://user@localhost:5432/mydb?pool_size=10&connection_timeout=5000&idle_timeout=30000"
            );
        });

        it("should only include set pool options", () => {
            const config = new PostgresConfig({
                database: "mydb",
                user: "user",
                pool: { size: 10 },
            });

            expect(config.toString()).toBe(
                "postgres://user@localhost:5432/mydb?pool_size=10"
            );
        });
    });
});
