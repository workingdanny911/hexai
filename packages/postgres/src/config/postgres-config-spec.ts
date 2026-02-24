import type { ConfigSpec } from "ezcfg";
import { PostgresConfig, type FromEnvOptions } from "./postgres-config";

export class PostgresConfigSpec implements ConfigSpec<PostgresConfig> {
    readonly _type = "postgres";

    constructor(
        private readonly prefix: string,
        private readonly mode: FromEnvOptions["mode"] = "url"
    ) {}

    resolve(errors: string[], envSource?: Record<string, string>): PostgresConfig | undefined {
        try {
            return PostgresConfig.fromEnv(this.prefix, { mode: this.mode }, envSource);
        } catch (e) {
            errors.push((e as Error).message);
            return undefined;
        }
    }
}

/**
 * PostgreSQL database configuration from environment variables.
 * Returns a PostgresConfig instance.
 *
 * @param prefix - Environment variable prefix
 * @param mode - "url" reads {PREFIX}_URL, "fields" reads individual fields
 *
 * @example
 * ```typescript
 * import { defineConfig, env } from "@hexaijs/core";
 * import { postgresConfig } from "@hexaijs/postgres";
 *
 * const getConfig = defineConfig({
 *     db: postgresConfig("ORDER_DB"),           // reads ORDER_DB_URL
 *     db2: postgresConfig("PG", "fields"),      // reads PG_HOST, PG_PORT, etc.
 * });
 *
 * getConfig().db.host;        // "localhost"
 * getConfig().db.toString();  // "postgres://..."
 * ```
 */
export function postgresConfig(
    prefix: string,
    mode: FromEnvOptions["mode"] = "url"
): PostgresConfigSpec {
    return new PostgresConfigSpec(prefix, mode);
}
