import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    defineConfig,
    env,
    envNumber,
    envBoolean,
} from "ezcfg";
import { postgresConfig } from "./postgres-config-spec";
import { PostgresConfig } from "./postgres-config";

describe("PostgresSpec", () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv, NODE_ENV: "test" };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe("postgres() builder", () => {
        it("should resolve PostgresConfig from URL env", () => {
            process.env.ORDER_DB_URL =
                "postgres://user:pass@localhost:5432/orderdb";

            const getConfig = defineConfig({ db: postgresConfig("ORDER_DB") });

            const config = getConfig();
            expect(config.db).toBeInstanceOf(PostgresConfig);
            expect(config.db.host).toBe("localhost");
            expect(config.db.port).toBe(5432);
            expect(config.db.database).toBe("orderdb");
            expect(config.db.user).toBe("user");
        });

        it("should resolve PostgresConfig from fields env", () => {
            process.env.PG_DATABASE = "testdb";
            process.env.PG_HOST = "dbhost";
            process.env.PG_PORT = "5433";
            process.env.PG_USER = "admin";
            process.env.PG_PASSWORD = "secret";

            const getConfig = defineConfig({
                db: postgresConfig("PG", "fields"),
            });

            const config = getConfig();
            expect(config.db.database).toBe("testdb");
            expect(config.db.host).toBe("dbhost");
            expect(config.db.port).toBe(5433);
        });

        it("should include postgres error in validation errors", () => {
            const getConfig = defineConfig({
                db: postgresConfig("MISSING_DB"),
            });

            expect(() => getConfig()).toThrow(
                "Environment variable MISSING_DB_URL is not set"
            );
        });

        it("should allow using PostgresConfig builder methods", () => {
            process.env.ORDER_DB_URL =
                "postgres://user:pass@localhost:5432/orderdb";

            const getConfig = defineConfig({ db: postgresConfig("ORDER_DB") });

            const testDb = getConfig()
                .db.withDatabase("testdb")
                .withPoolSize(10);

            expect(testDb.database).toBe("testdb");
            expect(testDb.pool?.size).toBe(10);
        });
    });

    describe("mixed config with env specs", () => {
        it("should work with env specs from @hexaijs/core", () => {
            process.env.DB_URL = "postgres://user:pass@localhost:5432/mydb";
            process.env.API_KEY = "secret";
            process.env.PORT = "3000";
            process.env.DEBUG = "true";

            const getConfig = defineConfig({
                db: postgresConfig("DB"),
                apiKey: env("API_KEY"),
                port: envNumber("PORT"),
                debug: envBoolean("DEBUG"),
            });

            const config = getConfig();

            expect(config.db).toBeInstanceOf(PostgresConfig);
            expect(config.db.database).toBe("mydb");
            expect(config.apiKey).toBe("secret");
            expect(config.port).toBe(3000);
            expect(config.debug).toBe(true);
        });
    });
});
