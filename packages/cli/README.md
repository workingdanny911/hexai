# @hexaijs/cli

> Unified CLI tool for hexai plugins

`@hexaijs/cli` provides the `hexai` command. The command does nothing by itself: each plugin you list in `hexai.config.ts` adds one subcommand, such as `hexai generate-contracts`. Use it to run the hexai code generators from one place, or to give your own build tools the same command line.

## Installation

Install the CLI together with the plugins you want to run:

```bash
pnpm add -D @hexaijs/cli @hexaijs/plugin-contracts-generator
```

The CLI has one peer dependency, `typescript`. The supported versions are the `peerDependencies` range in `package.json`.

The CLI loads `hexai.config.ts` with Node's own `import()`, so Node.js must be able to run TypeScript files. Node.js 22.18+ and 23.6+ do this by default by stripping types. Keep the file to syntax that can be erased, such as type annotations, `import type` and `satisfies`. On older Node.js versions, use `hexai.config.js` or `hexai.config.json` instead.

These first-party plugins work with the CLI:

| Plugin package | Command | What it does |
|----------------|---------|--------------|
| [`@hexaijs/plugin-contracts-generator`](../plugin-contracts-generator/README.md) | `hexai generate-contracts` | Extracts contract declarations from bounded contexts into a contracts package |
| [`@hexaijs/plugin-application-builder`](../plugin-application-builder/README.md) | `hexai generate-app-builder` | Generates `ApplicationBuilder` registration code from decorated handlers |

## Quick Start

1. Create `hexai.config.ts` in your project root:

    ```typescript
    import type { HexaiConfig } from "@hexaijs/cli";

    export default {
        plugins: [
            {
                plugin: "@hexaijs/plugin-contracts-generator",
                config: {
                    contexts: ["packages/orders"],
                },
            },
        ],
    } satisfies HexaiConfig;
    ```

    Each entry names a plugin package and the `config` object to pass to it. Here the contracts generator scans the `src/` directory of `packages/orders`.

2. Run the plugin's command from the same directory:

    ```bash
    pnpm hexai generate-contracts -o packages/contracts/src
    ```

3. List the commands your plugins provide, or the options of one command:

    ```bash
    pnpm hexai --help
    pnpm hexai generate-contracts --help
    ```

## Configuration

### Where the CLI looks for the config

The CLI looks in the current directory for these files, in this order, and loads the first one it finds:

1. `hexai.config.ts`
2. `hexai.config.js`
3. `hexai.config.json`

If the current directory has none of them, the CLI repeats the search in each parent directory up to the filesystem root.

To load a specific file instead, pass `-c, --config <path>`. A relative path is resolved against the current directory. The flag works before or after the command name:

```bash
pnpm hexai --config tools/hexai.config.ts generate-contracts -o packages/contracts/src
```

A `.ts` or `.js` config exports the config object as its default export. A `.json` config holds the object itself.

### Config shape

The config is a `HexaiConfig` object with one property, `plugins`. Each entry in `plugins` is a `PluginEntry`:

| Property | Type | Description |
|----------|------|-------------|
| `plugin` | `string` | Package name of the plugin. The package must export `cliPlugin`. |
| `config` | `unknown` | Required. Passed unchanged to the plugin when its command runs. Use `{}` if the plugin needs no configuration. |

This config registers both first-party plugins:

```typescript
import type { HexaiConfig } from "@hexaijs/cli";

export default {
    plugins: [
        {
            plugin: "@hexaijs/plugin-contracts-generator",
            config: {
                contexts: ["packages/*"],
            },
        },
        {
            plugin: "@hexaijs/plugin-application-builder",
            config: {},
        },
    ],
} satisfies HexaiConfig;
```

The CLI checks only the shape above. Each plugin validates its own `config` when its command runs; see the plugin's README for the options it accepts.

### Run from the directory that holds the config

Both first-party plugins resolve relative paths, such as `contexts` entries and `-o`, against the current directory, not against the config file. If you run `hexai` from a subdirectory, the CLI still finds the config in a parent directory, but the paths point somewhere else and the generator finds nothing. Run `hexai` from the directory that holds `hexai.config.ts`, for example through a `package.json` script in that directory.

## Commands

The CLI itself has these options:

| Option | Description |
|--------|-------------|
| `-c, --config <path>` | Load this config file instead of searching for one |
| `-h, --help` | List the commands registered by your plugins |

Every other command comes from a plugin, and the plugin's README documents its options: see [`@hexaijs/plugin-contracts-generator`](../plugin-contracts-generator/README.md) for `generate-contracts` and [`@hexaijs/plugin-application-builder`](../plugin-application-builder/README.md) for `generate-app-builder`.

```bash
pnpm hexai generate-contracts -o packages/contracts/src --registry
pnpm hexai generate-app-builder --context-path packages/orders
```

The CLI loads the config and every plugin before it reads the command line. If the config is missing or a plugin fails to load, even `hexai --help` fails.

## Errors

On any of these errors the CLI prints a message and exits with code 1:

| Situation | Message |
|-----------|---------|
| No config file found | `Configuration Error: No hexai config file found. Searched for:` followed by every path it checked, and a sample config |
| The config file fails to load or has the wrong shape | `Configuration Error: Failed to load config from <path>: <reason>`, for example `plugins[0].config is required (use empty object {} if no config needed)` |
| A plugin package cannot be imported | `Plugin Error: Plugin "<name>" not found: <reason>`, followed by an install hint |
| A plugin package has no `cliPlugin` export | `Plugin Error: Plugin "<name>" does not export 'cliPlugin'. ...` |
| `cliPlugin` has the wrong shape | `Plugin Error: Plugin "<name>" has invalid cliPlugin: <reason>`, for example `'run' must be a function` |
| A command fails while it runs | `Error running <command>: <error message>` |

## Writing a Plugin

A plugin is an npm package whose main entry point exports `cliPlugin`, an object that implements `HexaiCliPlugin`. The CLI imports the package by the name given in `plugin`, reads `cliPlugin` and registers it as a Commander.js subcommand.

```typescript
import type { CliOption, HexaiCliPlugin } from "@hexaijs/cli";

export interface GreetPluginConfig {
    greeting: string;
}

export const cliPlugin: HexaiCliPlugin<GreetPluginConfig> = {
    name: "greet",
    description: "Print a greeting",
    options: [
        {
            flags: "-n, --name <name>",
            description: "Who to greet",
            required: true,
        },
        {
            flags: "--shout",
            description: "Print the greeting in upper case",
        },
    ] satisfies CliOption[],
    run: async (args, config) => {
        const message = `${config.greeting}, ${String(args.name)}!`;
        console.log(args.shout === true ? message.toUpperCase() : message);
    },
};
```

With `{ plugin: "my-hexai-plugin", config: { greeting: "Hello" } }` in `hexai.config.ts`, `pnpm hexai greet --name Ada --shout` prints `HELLO, ADA!`.

Declare the CLI as a peer dependency, with the range the first-party plugins use:

```json
{
    "peerDependencies": {
        "@hexaijs/cli": "^0.2.0"
    }
}
```

If your package also works without the CLI, mark the peer as optional with `peerDependenciesMeta`, as `@hexaijs/plugin-contracts-generator` does.

### `HexaiCliPlugin<TConfig>`

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Subcommand name: `"greet"` becomes `hexai greet`. Must not be empty. |
| `description` | `string` | Shown in `hexai --help` |
| `options` | `CliOption[]` | The command's options |
| `run` | `(args: Record<string, unknown>, config: TConfig) => Promise<void>` | Runs the command with the parsed options and the plugin's `config` from `hexai.config.ts` |

### `CliOption`

| Property | Type | Description |
|----------|------|-------------|
| `flags` | `string` | Commander.js flag syntax, for example `"-o, --output-dir <path>"` |
| `description` | `string` | Shown in the command's help |
| `required` | `boolean` | If `true`, the command fails when the option is missing. Defaults to `false`. |
| `defaultValue` | `string` | Value used when the option is not given |

Commander.js decides what lands in `args`:

| Flag pattern | Example | Value in `args` |
|--------------|---------|-----------------|
| `--flag` | `--shout` | `true` when given, otherwise absent |
| `--option <value>` | `-n, --name <name>` | The string given; the value is required when the option is used |
| `--option [value]` | `--report [path]` | The string given, or `true` when used without a value |

Keys are the long flag names in camelCase: `--output-dir` becomes `args.outputDir`. Values arrive as strings or booleans, so convert and validate them in `run`.

Do not use `-c` or `--config` as plugin flags. The CLI reads them as the config path before Commander.js parses the command line.

## Programmatic API

The package also exports the pieces the `hexai` command is built from:

```typescript
import { loadConfig, loadPlugins } from "@hexaijs/cli";

const { config, configPath } = await loadConfig({ searchParents: true });
const plugins = await loadPlugins(config.plugins);

for (const { plugin } of plugins) {
    console.log(`${plugin.name} (from ${configPath})`);
}
```

| Export | Description |
|--------|-------------|
| `loadConfig(options?)` | Finds and loads the config. Options: `cwd` (default `process.cwd()`) and `searchParents` (default `false`; the `hexai` command passes `true`). Returns `{ config, configPath }`. |
| `loadConfigFromPath(path)` | Loads and validates one config file. Pass an absolute path. |
| `findConfigFile(options?)` | Returns the config path that `loadConfig()` would use, or `null` |
| `CONFIG_FILE_NAMES` | The file names searched, in order |
| `loadPlugin(entry)`, `loadPlugins(entries)` | Import plugin packages and validate their `cliPlugin`. Return `{ pluginName, plugin, config }` for each. |
| `createProgram(options?)` | Builds the Commander.js program with every plugin registered. Options: `configPath`, `argv`. |
| `main()` | Runs the `hexai` command with `process.argv` |
| `handleError(error)` | Prints the messages listed under [Errors](#errors) |
| `ConfigNotFoundError`, `ConfigLoadError` | Thrown by the config loader |
| `PluginNotFoundError`, `PluginExportError`, `PluginValidationError` | Thrown by the plugin loader |
| `HexaiConfig`, `PluginEntry`, `HexaiCliPlugin`, `CliOption`, `LoadConfigOptions`, `LoadConfigResult`, `LoadPluginResult`, `CreateProgramOptions` | Types |

## License

MIT
