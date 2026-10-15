# @hexaijs/utils

> Configuration helpers for hexai applications, re-exported from ezcfg

`@hexaijs/utils` has one entry point, `@hexaijs/utils/config`. It re-exports everything from the main entry point of [ezcfg](https://www.npmjs.com/package/ezcfg), a library that reads environment variables into a typed, validated config object. The package exists so that code importing from `@hexaijs/utils/config` keeps working; new code can depend on `ezcfg` directly. The ezcfg README is the full reference for the API.

## Installation

```bash
npm install @hexaijs/utils
```

The package has no peer dependencies. It depends on `ezcfg` `^0.3.0`, so the exact API depends on the ezcfg 0.3.x release that gets installed. This README describes ezcfg 0.3.1.

## Quick Start

```typescript
import {
    defineConfig,
    env,
    envBoolean,
    envNumber,
    envOptional,
} from "@hexaijs/utils/config";

export const getConfig = defineConfig(
    {
        apiKey: env("API_KEY"),
        port: envNumber("PORT"),
        debug: envBoolean("DEBUG", false),
        logLevel: envOptional("LOG_LEVEL", "info"),
        appName: "orders",
    },
    { loadEnv: true }
);

const config = getConfig();
config.apiKey; // string
config.port; // number
config.debug; // boolean
config.logLevel; // string
config.appName; // string
```

`defineConfig()` returns a function. The first call reads the environment, validates every entry and returns the config object. With `loadEnv: true`, that first call also loads `.env` files into `process.env`.

The config type is inferred from the schema. Each spec, such as `env("API_KEY")`, describes how to read one value.

## How It Works

- **Lazy and cached.** The config is read on the first call of the getter and cached after that. When `NODE_ENV` is `"test"`, every call reads the environment again, so tests can change variables between calls.
- **All errors at once.** Missing or unparsable values do not stop at the first problem. The getter collects every error and throws one `ConfigValidationError`, whose `errors` property lists them, for example `Missing required env: API_KEY`.
- **Plain values pass through.** Entries that are not specs, such as `appName: "orders"` above, are copied into the config as they are.
- **`.env` files.** `loadEnvFiles()`, or `loadEnv: true`, loads `.env` files from the current directory. `NODE_ENV` defaults to `development`. A variable is taken from the first of these places that sets it: the environment itself, `.env.<NODE_ENV>.local`, `.env.<NODE_ENV>`, `.env.local`, `.env`.

| Spec | Value | When the variable is missing |
|------|-------|------------------------------|
| `env(key)` | The string | Error |
| `envOptional(key, default?)` | The string | `default`, or `undefined` |
| `envNumber(key)` | The string converted with `Number` | Error |
| `envNumberOptional(key, default?)` | The string converted with `Number` | `default`, or `undefined` |
| `envBoolean(key, default?)` | `true` for `"true"` and `"1"`, otherwise `false` | `default`, or `false` |
| `envJson<T>(key)` | The string parsed with `JSON.parse`, typed as `T` | Error |
| `envJsonOptional<T>(key, default?)` | The string parsed with `JSON.parse`, typed as `T` | `default`, or `undefined` |
| `computed(factory)` | What `factory` returns | Not applicable |

An empty string counts as missing for the required specs. `Number` does not throw, so a non-numeric value becomes `NaN` instead of an error.

The inferred config type leaves `undefined` out for the optional specs: `envOptional("LOG_LEVEL")` is typed `string` even though the value is `undefined` when `LOG_LEVEL` is not set. Give optional specs a default, or check the value before you use it.

## Custom Specs

A spec is any object with a `resolve(errors, envSource?)` method; the `ConfigSpec<T>` interface also asks for a `_type` label. `resolve` returns the value, or pushes a message onto `errors` and returns `undefined`. Push instead of throwing: a thrown error stops `defineConfig()` at that entry instead of joining the collected errors. `envSource` is set when `defineConfig()` runs with `fromEnvFile`; read from it when it is given.

```typescript
import { defineConfig, type ConfigSpec } from "@hexaijs/utils/config";

type RedisConfig = { host: string; port: number };

class RedisSpec implements ConfigSpec<RedisConfig> {
    readonly _type = "redis";

    constructor(private readonly prefix: string) {}

    resolve(
        errors: string[],
        envSource?: Record<string, string>
    ): RedisConfig | undefined {
        const source = envSource ?? process.env;
        const host = source[`${this.prefix}_HOST`];
        if (!host) {
            errors.push(`Missing required env: ${this.prefix}_HOST`);
            return undefined;
        }

        const port = source[`${this.prefix}_PORT`];
        return { host, port: port ? Number(port) : 6379 };
    }
}

export const getConfig = defineConfig({
    redis: new RedisSpec("REDIS"),
});
```

`getConfig().redis` is typed `RedisConfig`.

## Exports

`@hexaijs/utils/config` exports the same names as the main entry point of `ezcfg` 0.3.1:

| Export | Description |
|--------|-------------|
| `defineConfig(schema, options?)` | Creates the config getter. Options: `loadEnv`, `envLoader` (a function to call instead of `loadEnvFiles()`) and `fromEnvFile` (read values from this file instead of `process.env`). |
| `ConfigOptions` | Options type of `defineConfig` |
| `env`, `envOptional`, `envNumber`, `envNumberOptional`, `envBoolean`, `envJson`, `envJsonOptional`, `EnvSpec` | Specs that read one environment variable |
| `computed`, `ComputedSpec` | Spec whose value comes from a function |
| `ConfigSpec<T>`, `isConfigSpec` | Interface for custom specs, and its type guard |
| `InferConfigType`, `InferSpecType` | Types that derive the config type from a schema |
| `ConfigValidationError` | Error thrown with all validation errors |
| `loadEnvFiles(options?)` | Loads `.env` files. Options: `basePath`, `nodeEnv`. |
| `parseEnvFile(path)` | Parses one `.env` file into an object without touching `process.env` |
| `DatabaseConfig` | Interface for database connection settings |

The PostgreSQL helpers from `ezcfg/postgres` are not re-exported here. [`@hexaijs/postgres`](../postgres/README.md) exports `postgresConfig()`, a spec you can put in a `defineConfig()` schema, and `PostgresConfig`.
