import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    env,
    envOptional,
    envNumber,
    envNumberOptional,
    envBoolean,
    envJson,
    envJsonOptional,
} from "./env-spec";
import { defineConfig } from "./define-config";
import { ConfigValidationError } from "./errors";

describe("EnvSpec", () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv, NODE_ENV: "test" };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe("env()", () => {
        it("should resolve required string env var", () => {
            process.env.API_KEY = "secret-key";

            const getConfig = defineConfig({ apiKey: env("API_KEY") });

            expect(getConfig().apiKey).toBe("secret-key");
        });

        it("should throw ConfigValidationError for missing required env", () => {
            const getConfig = defineConfig({ apiKey: env("MISSING_KEY") });

            expect(() => getConfig()).toThrow(ConfigValidationError);
            expect(() => getConfig()).toThrow("Missing required env: MISSING_KEY");
        });

        it("should collect all missing env vars in error", () => {
            const getConfig = defineConfig({
                key1: env("MISSING_1"),
                key2: env("MISSING_2"),
                key3: env("MISSING_3"),
            });

            try {
                getConfig();
                expect.fail("Should have thrown");
            } catch (e) {
                expect(e).toBeInstanceOf(ConfigValidationError);
                const error = e as ConfigValidationError;
                expect(error.errors).toHaveLength(3);
                expect(error.errors).toContain("Missing required env: MISSING_1");
                expect(error.errors).toContain("Missing required env: MISSING_2");
                expect(error.errors).toContain("Missing required env: MISSING_3");
            }
        });
    });

    describe("envOptional()", () => {
        it("should resolve optional env var", () => {
            process.env.LOG_LEVEL = "debug";

            const getConfig = defineConfig({ logLevel: envOptional("LOG_LEVEL") });

            expect(getConfig().logLevel).toBe("debug");
        });

        it("should use default value when env is not set", () => {
            const getConfig = defineConfig({ logLevel: envOptional("LOG_LEVEL", "info") });

            expect(getConfig().logLevel).toBe("info");
        });

        it("should return undefined when no default and env not set", () => {
            const getConfig = defineConfig({ logLevel: envOptional("LOG_LEVEL") });

            expect(getConfig().logLevel).toBeUndefined();
        });
    });

    describe("envNumber()", () => {
        it("should resolve and transform to number", () => {
            process.env.PORT = "3000";

            const getConfig = defineConfig({ port: envNumber("PORT") });

            expect(getConfig().port).toBe(3000);
            expect(typeof getConfig().port).toBe("number");
        });

        it("should throw for missing required number env", () => {
            const getConfig = defineConfig({ port: envNumber("PORT") });

            expect(() => getConfig()).toThrow("Missing required env: PORT");
        });
    });

    describe("envNumberOptional()", () => {
        it("should resolve optional number with default", () => {
            const getConfig = defineConfig({ timeout: envNumberOptional("TIMEOUT", 5000) });

            expect(getConfig().timeout).toBe(5000);
        });

        it("should parse env value when set", () => {
            process.env.TIMEOUT = "10000";

            const getConfig = defineConfig({ timeout: envNumberOptional("TIMEOUT", 5000) });

            expect(getConfig().timeout).toBe(10000);
        });
    });

    describe("envBoolean()", () => {
        it("should parse 'true' as true", () => {
            process.env.DEBUG = "true";

            const getConfig = defineConfig({ debug: envBoolean("DEBUG") });

            expect(getConfig().debug).toBe(true);
        });

        it("should parse '1' as true", () => {
            process.env.DEBUG = "1";

            const getConfig = defineConfig({ debug: envBoolean("DEBUG") });

            expect(getConfig().debug).toBe(true);
        });

        it("should parse other values as false", () => {
            process.env.DEBUG = "false";

            const getConfig = defineConfig({ debug: envBoolean("DEBUG") });

            expect(getConfig().debug).toBe(false);
        });

        it("should use default value when not set", () => {
            const getConfig = defineConfig({ debug: envBoolean("DEBUG", true) });

            expect(getConfig().debug).toBe(true);
        });
    });

    describe("envJson()", () => {
        it("should parse JSON env var", () => {
            process.env.CONFIG = JSON.stringify({ key: "value", num: 42 });

            const getConfig = defineConfig({
                config: envJson<{ key: string; num: number }>("CONFIG"),
            });

            expect(getConfig().config).toEqual({ key: "value", num: 42 });
        });

        it("should throw for invalid JSON", () => {
            process.env.CONFIG = "not-valid-json";

            const getConfig = defineConfig({ config: envJson("CONFIG") });

            expect(() => getConfig()).toThrow("Failed to transform CONFIG");
        });

        it("should throw for missing required JSON env", () => {
            const getConfig = defineConfig({ config: envJson("CONFIG") });

            expect(() => getConfig()).toThrow("Missing required env: CONFIG");
        });
    });

    describe("envJsonOptional()", () => {
        it("should return default when not set", () => {
            const defaultConfig = { level: "info" };
            const getConfig = defineConfig({ config: envJsonOptional("CONFIG", defaultConfig) });

            expect(getConfig().config).toEqual(defaultConfig);
        });

        it("should parse JSON when set", () => {
            process.env.CONFIG = JSON.stringify({ level: "debug" });

            const getConfig = defineConfig({ config: envJsonOptional("CONFIG", { level: "info" }) });

            expect(getConfig().config).toEqual({ level: "debug" });
        });
    });

    describe("singleton behavior", () => {
        it("should return same instance in non-test environment", () => {
            process.env.NODE_ENV = "production";
            process.env.API_KEY = "key1";

            const getConfig = defineConfig({ apiKey: env("API_KEY") });

            const config1 = getConfig();

            process.env.API_KEY = "key2";

            const config2 = getConfig();

            expect(config1).toBe(config2);
            expect(config1.apiKey).toBe("key1");
        });

        it("should recreate config in test environment", () => {
            process.env.NODE_ENV = "test";
            process.env.API_KEY = "key1";

            const getConfig = defineConfig({ apiKey: env("API_KEY") });

            const config1 = getConfig();
            expect(config1.apiKey).toBe("key1");

            process.env.API_KEY = "key2";

            const config2 = getConfig();
            expect(config2.apiKey).toBe("key2");
        });
    });

    describe("type inference", () => {
        it("should infer correct types", () => {
            process.env.API_KEY = "secret";
            process.env.PORT = "3000";
            process.env.DEBUG = "true";
            process.env.CONFIG = "{}";

            const getConfig = defineConfig({
                apiKey: env("API_KEY"),
                port: envNumber("PORT"),
                debug: envBoolean("DEBUG"),
                optional: envOptional("OPTIONAL"),
                json: envJson<{ key: string }>("CONFIG"),
            });

            const config = getConfig();

            // Type assertions - these would fail at compile time if types are wrong
            const _apiKey: string = config.apiKey;
            const _port: number = config.port;
            const _debug: boolean = config.debug;
            const _optional: string | undefined = config.optional;
            const _json: { key: string } = config.json;

            expect(_apiKey).toBeDefined();
            expect(_port).toBeDefined();
            expect(_debug).toBeDefined();
            expect(_json).toBeDefined();
        });
    });
});
