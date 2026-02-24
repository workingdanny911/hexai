import type { DatabaseConfig } from "ezcfg";

export interface PoolOptions {
    size?: number;
    connectionTimeout?: number;
    idleTimeout?: number;
}

export interface FromEnvOptions {
    /**
     * Environment variable loading mode.
     * - "url": Load from {PREFIX}_URL (default)
     * - "fields": Load from {PREFIX}_HOST, {PREFIX}_PORT, {PREFIX}_DATABASE, {PREFIX}_USER, {PREFIX}_PASSWORD
     */
    mode?: "url" | "fields";
}

export class PostgresConfig implements DatabaseConfig {
    public readonly host: string;
    public readonly database: string;
    public readonly user: string;
    public readonly port: number;
    public readonly password?: string;
    public readonly pool?: PoolOptions;

    constructor(config: {
        database: string;
        user?: string;
        host?: string;
        port?: number;
        password?: string;
        pool?: PoolOptions;
    }) {
        this.database = config.database;
        this.password = config.password;
        this.host = config.host ?? "localhost";
        this.user = config.user ?? "postgres";
        this.port = config.port ?? 5432;
        this.pool = config.pool;
    }

    public static fromUrl(value: string): PostgresConfig {
        return new PostgresConfig(PostgresConfig.parseUrl(value));
    }

    /**
     * Creates a PostgresConfig from environment variables.
     *
     * @param prefix - Environment variable prefix
     * @param options - Loading options (mode: "url" | "fields")
     * @throws Error if required environment variables are not set
     *
     * @example
     * ```typescript
     * // URL mode (default): reads ASSIGNMENT_DB_URL
     * const config = PostgresConfig.fromEnv("ASSIGNMENT_DB");
     *
     * // Fields mode: reads POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DATABASE, POSTGRES_USER, POSTGRES_PASSWORD
     * const config = PostgresConfig.fromEnv("POSTGRES", { mode: "fields" });
     * ```
     */
    public static fromEnv(
        prefix: string,
        options?: FromEnvOptions,
        envSource?: Record<string, string>
    ): PostgresConfig {
        const source = envSource ?? process.env;
        const mode = options?.mode ?? "url";

        if (mode === "url") {
            const envKey = `${prefix}_URL`;
            const url = source[envKey];

            if (!url) {
                throw new Error(`Environment variable ${envKey} is not set`);
            }

            return PostgresConfig.fromUrl(url);
        }

        // fields mode
        const database = source[`${prefix}_DATABASE`];
        if (!database) {
            throw new Error(
                `Environment variable ${prefix}_DATABASE is not set`
            );
        }

        return new PostgresConfig({
            database,
            host: source[`${prefix}_HOST`],
            port: source[`${prefix}_PORT`]
                ? parseInt(source[`${prefix}_PORT`]!)
                : undefined,
            user: source[`${prefix}_USER`],
            password: source[`${prefix}_PASSWORD`],
        });
    }

    private static parseUrl(value: string) {
        const regex =
            /postgres(ql)?:\/\/(?<user>[^:/]+)(:(?<password>[^@]+))?@(?<host>[^:/]+)(:(?<port>\d+))?\/(?<database>.+)/;

        const matches = value.match(regex);

        if (!matches?.groups) {
            throw new Error(`Invalid postgres url: ${value}`);
        }

        const { user, password, host, port, database } = matches.groups;

        return {
            host,
            database,
            user,
            port: port ? parseInt(port) : 5432,
            password,
        };
    }

    public withDatabase(database: string): PostgresConfig {
        return new PostgresConfig({
            host: this.host,
            database,
            user: this.user,
            port: this.port,
            password: this.password,
            pool: this.pool,
        });
    }

    public withUser(user: string): PostgresConfig {
        return new PostgresConfig({
            host: this.host,
            database: this.database,
            user,
            port: this.port,
            password: this.password,
            pool: this.pool,
        });
    }

    public withPassword(password: string): PostgresConfig {
        return new PostgresConfig({
            host: this.host,
            database: this.database,
            user: this.user,
            port: this.port,
            password,
            pool: this.pool,
        });
    }

    public withHost(host: string): PostgresConfig {
        return new PostgresConfig({
            host,
            database: this.database,
            user: this.user,
            port: this.port,
            password: this.password,
            pool: this.pool,
        });
    }

    public withPort(port: number): PostgresConfig {
        return new PostgresConfig({
            host: this.host,
            database: this.database,
            user: this.user,
            port,
            password: this.password,
            pool: this.pool,
        });
    }

    public withPoolSize(size: number): PostgresConfig {
        return new PostgresConfig({
            host: this.host,
            database: this.database,
            user: this.user,
            port: this.port,
            password: this.password,
            pool: { ...this.pool, size },
        });
    }

    public withConnectionTimeout(connectionTimeout: number): PostgresConfig {
        return new PostgresConfig({
            host: this.host,
            database: this.database,
            user: this.user,
            port: this.port,
            password: this.password,
            pool: { ...this.pool, connectionTimeout },
        });
    }

    public withIdleTimeout(idleTimeout: number): PostgresConfig {
        return new PostgresConfig({
            host: this.host,
            database: this.database,
            user: this.user,
            port: this.port,
            password: this.password,
            pool: { ...this.pool, idleTimeout },
        });
    }

    public toString(): string {
        let url = `postgres://${this.user}`;

        if (this.password) {
            url += `:${this.password}`;
        }
        url += `@${this.host}:${this.port}/${this.database}`;

        const queryParams: string[] = [];
        if (this.pool?.size !== undefined) {
            queryParams.push(`pool_size=${this.pool.size}`);
        }
        if (this.pool?.connectionTimeout !== undefined) {
            queryParams.push(
                `connection_timeout=${this.pool.connectionTimeout}`
            );
        }
        if (this.pool?.idleTimeout !== undefined) {
            queryParams.push(`idle_timeout=${this.pool.idleTimeout}`);
        }

        if (queryParams.length > 0) {
            url += `?${queryParams.join("&")}`;
        }

        return url;
    }
}
