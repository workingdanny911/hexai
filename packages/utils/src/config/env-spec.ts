import type { ConfigSpec } from "./config-spec";

/**
 * Config spec for environment variables.
 * Use the builder functions (env, envOptional, envNumber, etc.) instead of instantiating directly.
 */
export class EnvSpec<T> implements ConfigSpec<T> {
    readonly _type = "env";

    constructor(
        private readonly envKey: string,
        private readonly required: boolean,
        private readonly defaultValue?: T,
        private readonly transform?: (value: string) => T
    ) {}

    resolve(errors: string[]): T | undefined {
        const rawValue = process.env[this.envKey];

        if (!rawValue && this.required) {
            errors.push(`Missing required env: ${this.envKey}`);
            return undefined;
        }

        if (rawValue !== undefined) {
            try {
                return this.transform ? this.transform(rawValue) : (rawValue as T);
            } catch (e) {
                errors.push(`Failed to transform ${this.envKey}: ${(e as Error).message}`);
                return undefined;
            }
        }

        return this.defaultValue;
    }
}

/**
 * Required string environment variable.
 *
 * @example
 * ```typescript
 * const getConfig = defineConfig({
 *     apiKey: env("API_KEY"),
 * });
 * ```
 */
export function env(key: string): EnvSpec<string> {
    return new EnvSpec(key, true);
}

/**
 * Optional string environment variable with default value.
 *
 * @example
 * ```typescript
 * const getConfig = defineConfig({
 *     logLevel: envOptional("LOG_LEVEL", "info"),
 * });
 * ```
 */
export function envOptional(key: string, defaultValue?: string): EnvSpec<string | undefined> {
    return new EnvSpec(key, false, defaultValue);
}

/**
 * Required number environment variable.
 *
 * @example
 * ```typescript
 * const getConfig = defineConfig({
 *     port: envNumber("PORT"),
 * });
 * ```
 */
export function envNumber(key: string): EnvSpec<number> {
    return new EnvSpec(key, true, undefined, Number);
}

/**
 * Optional number environment variable with default value.
 */
export function envNumberOptional(key: string, defaultValue?: number): EnvSpec<number | undefined> {
    return new EnvSpec(key, false, defaultValue, (v) => (v ? Number(v) : undefined));
}

/**
 * Boolean environment variable. Recognizes "true", "1" as true.
 *
 * @example
 * ```typescript
 * const getConfig = defineConfig({
 *     debug: envBoolean("DEBUG", false),
 * });
 * ```
 */
export function envBoolean(key: string, defaultValue = false): EnvSpec<boolean> {
    return new EnvSpec(key, false, defaultValue, (v) => v === "true" || v === "1");
}

/**
 * JSON environment variable. Parses JSON string into object.
 *
 * @example
 * ```typescript
 * const getConfig = defineConfig({
 *     prompts: envJson<{ system: string }>("PROMPTS"),
 * });
 * ```
 */
export function envJson<T>(key: string): EnvSpec<T> {
    return new EnvSpec(key, true, undefined, JSON.parse);
}

/**
 * Optional JSON environment variable with default value.
 */
export function envJsonOptional<T>(key: string, defaultValue?: T): EnvSpec<T | undefined> {
    return new EnvSpec(key, false, defaultValue, (v) => (v ? JSON.parse(v) : undefined));
}
