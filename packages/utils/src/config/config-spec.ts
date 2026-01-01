/**
 * Base interface for all config specs.
 * Implement this interface to create custom config specs that can be used with defineConfig.
 *
 * @example
 * ```typescript
 * class RedisSpec implements ConfigSpec<RedisConfig> {
 *     readonly _type = "redis";
 *
 *     constructor(private prefix: string) {}
 *
 *     resolve(errors: string[]): RedisConfig | undefined {
 *         try {
 *             return RedisConfig.fromEnv(this.prefix);
 *         } catch (e) {
 *             errors.push((e as Error).message);
 *             return undefined;
 *         }
 *     }
 * }
 * ```
 */
export interface ConfigSpec<T> {
    /**
     * Unique type identifier for this spec.
     * Used for debugging and error messages.
     */
    readonly _type: string;

    /**
     * Resolve the config value from environment.
     * Should push error messages to the errors array instead of throwing.
     *
     * @param errors - Array to collect validation errors
     * @returns The resolved value, or undefined if resolution failed
     */
    resolve(errors: string[]): T | undefined;
}

/**
 * Type helper to infer result type from a ConfigSpec.
 */
export type InferSpecType<S> = S extends ConfigSpec<infer T> ? T : S;

/**
 * Type helper to infer config object type from schema.
 */
export type InferConfigType<S extends Record<string, unknown>> = {
    readonly [K in keyof S]: InferSpecType<S[K]>;
};


export function isConfigSpec(value: unknown): value is ConfigSpec<unknown> {
    return (
        typeof value === "object" &&
        value !== null &&
        "resolve" in value &&
        typeof (value as ConfigSpec<unknown>).resolve === "function"
    );
}
