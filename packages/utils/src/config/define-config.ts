import { type InferConfigType, isConfigSpec } from "./config-spec";
import { ConfigValidationError } from "./errors";
import { loadEnvFiles } from "./load-env-files";

export interface ConfigOptions {
    /**
     * Whether to load .env files before resolving config.
     * @default false
     */
    loadEnv?: boolean;

    /**
     * Custom env loader function. Called when loadEnv is true.
     * If not provided and loadEnv is true, uses dotenv.config().
     */
    envLoader?: () => void;
}

/**
 * Defines a typed configuration with automatic validation and singleton management.
 *
 * @param schema - Configuration schema defining all config fields
 * @param options - Optional configuration options
 * @returns A function that returns the resolved config (singleton)
 *
 * @example
 * ```typescript
 * import { defineConfig, env, envBoolean } from "@hexaijs/core";
 * import { postgres } from "@hexaijs/postgres";
 *
 * export const getConfig = defineConfig({
 *     db: postgres("ORDER_DB"),
 *     apiKey: env("API_KEY"),
 *     debug: envBoolean("DEBUG", false),
 *     // Primitive values are also supported
 *     appName: "my-app",
 *     maxRetries: 3,
 * });
 *
 * // Usage
 * const config = getConfig();
 * config.db.host;      // PostgresConfig property
 * config.apiKey;       // string
 * config.debug;        // boolean
 * config.appName;      // "my-app" (literal type)
 * config.maxRetries;   // 3 (literal type)
 * ```
 */
export function defineConfig<S extends Record<string, unknown>>(
    schema: S,
    options?: ConfigOptions
): () => InferConfigType<S> {
    let instance: InferConfigType<S> | null = null;

    return () => {
        // In test environment, always recreate to reflect env changes
        if (instance && process.env.NODE_ENV !== "test") {
            return instance;
        }

        // Load env files if requested
        if (options?.loadEnv) {
            if (options.envLoader) {
                options.envLoader();
            } else {
                loadEnvFiles();
            }
        }

        const config = {} as Record<string, unknown>;
        const errors: string[] = [];

        for (const [key, value] of Object.entries(schema)) {
            if (isConfigSpec(value)) {
                config[key] = value.resolve(errors);
            } else {
                config[key] = value;
            }
        }

        if (errors.length > 0) {
            throw new ConfigValidationError(errors);
        }

        instance = config as InferConfigType<S>;
        return instance;
    };
}
