/**
 * Common interface for all database configurations.
 *
 * This interface defines the minimal contract that all database config
 * implementations (PostgresConfig, MySQLConfig, etc.) must satisfy.
 *
 * Note: Builder methods (with*) are intentionally NOT included here.
 * Each implementation returns its own concrete type for better type inference.
 */
export interface DatabaseConfig {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    readonly password?: string;

    /**
     * Returns the connection URL string representation.
     * Format varies by database type (e.g., postgres://, mysql://)
     */
    toString(): string;
}
