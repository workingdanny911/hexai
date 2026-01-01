# @hexaijs/utils

> Configuration management utilities for hexai applications

## Overview

`@hexaijs/utils` provides utilities for managing application configuration in a type-safe, validated manner. The package currently focuses on configuration management, offering a declarative approach to reading and validating environment variables.

The configuration system solves several common problems:

1. **Type Safety** - Environment variables are strings, but your application needs typed values (numbers, booleans, objects). The config system handles transformation and inference automatically.
2. **Validation at Startup** - Missing or invalid configuration is detected immediately when your application starts, not when the code path is first executed.
3. **Singleton Management** - Configuration is resolved once and cached, with special handling for test environments.
4. **Extensibility** - Custom config specs allow database packages and other infrastructure to integrate seamlessly.

## Installation

```bash
npm install @hexaijs/utils
```

## Core Concepts

### defineConfig

`defineConfig` creates a typed configuration getter that resolves and validates configuration on first access.

```typescript
import {
    defineConfig,
    env,
    envOptional,
    envNumber,
    envBoolean,
} from "@hexaijs/utils/config";

export const getConfig = defineConfig({
    // Required string
    apiKey: env("API_KEY"),

    // Optional with default
    logLevel: envOptional("LOG_LEVEL", "info"),

    // Required number
    port: envNumber("PORT"),

    // Boolean with default
    debug: envBoolean("DEBUG", false),

    // Static values are also supported
    appName: "my-app",
    maxRetries: 3,
});

// Usage
const config = getConfig();
config.apiKey;      // string
config.logLevel;    // string | undefined
config.port;        // number
config.debug;       // boolean
config.appName;     // "my-app" (literal type preserved)
config.maxRetries;  // 3 (literal type preserved)
```

The returned getter function caches the resolved config (singleton pattern). In test environments (`NODE_ENV=test`), the config is recreated on each call to reflect environment changes between tests.

### Environment Variable Specs

Builder functions for different data types:

| Function | Type | Description |
|----------|------|-------------|
| `env(key)` | `string` | Required string |
| `envOptional(key, default?)` | `string \| undefined` | Optional string with default |
| `envNumber(key)` | `number` | Required number |
| `envNumberOptional(key, default?)` | `number \| undefined` | Optional number |
| `envBoolean(key, default)` | `boolean` | Boolean (`"true"`, `"1"` → true) |
| `envJson<T>(key)` | `T` | Required JSON-parsed object |
| `envJsonOptional<T>(key, default?)` | `T \| undefined` | Optional JSON object |

```typescript
import {
    defineConfig,
    env,
    envNumber,
    envBoolean,
    envJson,
} from "@hexaijs/utils/config";

const getConfig = defineConfig({
    // Required - throws ConfigValidationError if missing
    databaseUrl: env("DATABASE_URL"),

    // Number transformation
    port: envNumber("PORT"),

    // Boolean - recognizes "true" and "1"
    enableMetrics: envBoolean("ENABLE_METRICS", false),

    // JSON parsing with type inference
    rateLimits: envJson<{ requests: number; window: number }>("RATE_LIMITS"),
});
```

### ConfigValidationError

When required environment variables are missing or transformation fails, `defineConfig` collects all errors and throws a single `ConfigValidationError`.

```typescript
import { defineConfig, env, ConfigValidationError } from "@hexaijs/utils/config";

const getConfig = defineConfig({
    apiKey: env("API_KEY"),
    secretKey: env("SECRET_KEY"),
    databaseUrl: env("DATABASE_URL"),
});

try {
    const config = getConfig();
} catch (e) {
    if (e instanceof ConfigValidationError) {
        console.error("Configuration errors:");
        e.errors.forEach(err => console.error(`  - ${err}`));
        // Config validation failed:
        //   - Missing required env: API_KEY
        //   - Missing required env: SECRET_KEY
        //   - Missing required env: DATABASE_URL
        process.exit(1);
    }
    throw e;
}
```

All validation errors are collected before throwing, so you see every missing variable at once rather than fixing them one at a time.

### Custom ConfigSpec

The `ConfigSpec` interface allows you to create custom configuration resolvers. Infrastructure packages like `@hexaijs/postgres` use this to provide database configuration specs.

```typescript
import type { ConfigSpec } from "@hexaijs/utils/config";

// Example: Custom config spec for Redis
class RedisSpec implements ConfigSpec<RedisConfig> {
    readonly _type = "redis";

    constructor(private prefix: string) {}

    resolve(errors: string[]): RedisConfig | undefined {
        const host = process.env[`${this.prefix}_HOST`];
        const port = process.env[`${this.prefix}_PORT`];

        if (!host) {
            errors.push(`Missing required env: ${this.prefix}_HOST`);
            return undefined;
        }

        return {
            host,
            port: port ? parseInt(port) : 6379,
        };
    }
}

// Usage with defineConfig
const getConfig = defineConfig({
    redis: new RedisSpec("REDIS"),
    apiKey: env("API_KEY"),
});
```

The `resolve` method should push error messages to the `errors` array instead of throwing, allowing all errors to be collected.

### DatabaseConfig Interface

A common interface that database configuration classes implement, enabling polymorphic handling of different databases.

```typescript
import type { DatabaseConfig } from "@hexaijs/utils/config";

// PostgresConfig from @hexaijs/postgres implements this interface
interface DatabaseConfig {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    readonly password?: string;
    toString(): string;  // Returns connection URL
}
```

This interface is used by database packages to provide type-safe configuration. See `@hexaijs/postgres` for a complete implementation.

### Loading .env Files

The `loadEnvFiles` function loads environment files following a standard precedence order.

```typescript
import { loadEnvFiles, defineConfig, env } from "@hexaijs/utils/config";

// Option 1: Load env files before defining config
loadEnvFiles();

const getConfig = defineConfig({
    apiKey: env("API_KEY"),
});

// Option 2: Use loadEnv option in defineConfig
const getConfig = defineConfig(
    { apiKey: env("API_KEY") },
    { loadEnv: true }
);
```

**File loading order** (later files override earlier):
1. `.env` - Default values
2. `.env.local` - Local overrides (gitignored)
3. `.env.{NODE_ENV}` - Environment-specific (e.g., `.env.test`)
4. `.env.{NODE_ENV}.local` - Local environment overrides

```typescript
// Custom base path and environment
loadEnvFiles({
    basePath: "/app/config",
    nodeEnv: "staging",
});
```

## Usage

### Application Configuration Pattern

A typical pattern for hexai applications:

```typescript
// config.ts
import { defineConfig, env, envBoolean, envNumber } from "@hexaijs/utils/config";
import { postgresConfig } from "@hexaijs/postgres";

export const getConfig = defineConfig(
    {
        db: postgresConfig("ORDER_DB"),  // ConfigSpec - errors collected properly
        port: envNumber("PORT"),
        debug: envBoolean("DEBUG", false),
        apiKey: env("API_KEY"),
    },
    { loadEnv: true }
);

// application-context.ts
import { getConfig } from "./config";

export class OrderApplicationContext {
    private readonly config = getConfig();

    getDatabase() {
        return this.config.db;
    }

    getPort() {
        return this.config.port;
    }
}
```

### Testing with Environment Changes

In test environments, the config is recreated on each call:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { defineConfig, env } from "@hexaijs/utils/config";

describe("MyService", () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv, NODE_ENV: "test" };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it("uses API_KEY from environment", () => {
        process.env.API_KEY = "test-key";

        const getConfig = defineConfig({ apiKey: env("API_KEY") });

        expect(getConfig().apiKey).toBe("test-key");
    });

    it("reflects environment changes", () => {
        process.env.API_KEY = "first-key";
        const getConfig = defineConfig({ apiKey: env("API_KEY") });

        expect(getConfig().apiKey).toBe("first-key");

        process.env.API_KEY = "second-key";
        expect(getConfig().apiKey).toBe("second-key");
    });
});
```

## API Highlights

| Export | Description |
|--------|-------------|
| `defineConfig(schema, options?)` | Creates typed config getter with validation |
| `env(key)` | Required string environment variable |
| `envOptional(key, default?)` | Optional string with default |
| `envNumber(key)` | Required number (transforms string) |
| `envNumberOptional(key, default?)` | Optional number |
| `envBoolean(key, default)` | Boolean (`"true"`, `"1"` → true) |
| `envJson<T>(key)` | Required JSON-parsed value |
| `envJsonOptional<T>(key, default?)` | Optional JSON value |
| `ConfigSpec<T>` | Interface for custom config specs |
| `ConfigValidationError` | Error containing all validation failures |
| `DatabaseConfig` | Common interface for database configs |
| `loadEnvFiles(options?)` | Loads .env files with NODE_ENV awareness |

## See Also

- [@hexaijs/postgres](../postgres/README.md) - PostgresConfig implements DatabaseConfig, `postgresConfig()` helper for use with defineConfig
- [@hexaijs/application](../application/README.md) - Application layer that uses configuration
