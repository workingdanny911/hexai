# @hexaijs/cli

> Unified CLI tool for hexai plugins

A Commander.js-based CLI that dynamically loads and runs hexai plugins registered in `hexai.config.ts`.

## Features

- **Plugin-based architecture**: Register plugins via configuration
- **Unified interface**: Single `hexai` command for all plugins
- **Type-safe configuration**: Full TypeScript support
- **Extensible**: Easy to add new plugins

## Installation

```bash
# In your project
pnpm add -D @hexaijs/cli

# The CLI is automatically available as `hexai` after installation
```

## Quick Start

1. Create a `hexai.config.ts` in your project root:

```typescript
export default {
    plugins: [
        {
            plugin: "@hexaijs/plugin-contracts-generator",
            config: {
                contexts: [
                    {
                        name: "my-context",
                        sourceDir: "packages/my-context/src",
                        tsconfigPath: "packages/my-context/tsconfig.json",
                    },
                ],
            },
        },
    ],
};
```

2. Run a command:

```bash
hexai generate-contracts -o packages/contracts/src
```

## Configuration

### Config File Location

The CLI searches for config files in this order:
1. `hexai.config.ts`
2. `hexai.config.js`
3. `hexai.config.json`

You can also specify a custom path:

```bash
hexai --config custom/path/config.ts generate-contracts -o dist
```

### Config Structure

```typescript
// hexai.config.ts
import type { HexaiConfig } from "@hexaijs/cli";

export default {
    plugins: [
        {
            plugin: "@hexaijs/plugin-contracts-generator",
            config: {
                // Plugin-specific configuration
                contexts: [...],
                responseNamingConventions: [...],
            },
        },
        {
            plugin: "@hexaijs/plugin-application-builder",
            config: {
                // Plugin-specific configuration
            },
        },
    ],
} satisfies HexaiConfig;
```

### Plugin Entry

Each plugin entry has two properties:

| Property | Type | Description |
|----------|------|-------------|
| `plugin` | `string` | Package name (must export `cliPlugin`) |
| `config` | `unknown` | Plugin-specific configuration passed to `run()` |

## Available Commands

### `hexai generate-contracts`

Extract domain events, commands, and queries from bounded contexts.

```bash
hexai generate-contracts -o <output-dir> [options]
```

**Options:**
| Option | Description |
|--------|-------------|
| `-o, --output-dir <path>` | (Required) Output directory for generated contracts |
| `-m, --message-types <types>` | Filter message types (comma-separated: event,command,query) |
| `--generate-message-registry` | Generate message registry index.ts file |

**Examples:**
```bash
# Generate all contracts
hexai generate-contracts -o packages/contracts/src

# Generate only events
hexai generate-contracts -o packages/contracts/src -m event

# Generate events and commands with registry
hexai generate-contracts -o packages/contracts/src -m event,command --generate-message-registry
```

### `hexai generate-app-builder`

Generate ApplicationBuilder code for a bounded context.

```bash
hexai generate-app-builder -p <context-path> [options]
```

**Options:**
| Option | Description |
|--------|-------------|
| `-p, --context-path <path>` | (Required) Path to the bounded context |
| `-f, --config-file <name>` | Config file name in context (default: `hexai.config.ts`) |

**Examples:**
```bash
# Generate ApplicationBuilder for assignment context
hexai generate-app-builder -p packages/assignment
```

## Plugin Development

### Creating a Plugin

1. **Define the plugin interface**:

```typescript
// src/hexai-plugin.ts
import type { HexaiCliPlugin, CliOption } from "@hexaijs/cli";

export interface MyPluginConfig {
    // Your plugin's configuration type
    option1: string;
    option2: boolean;
}

export const cliPlugin: HexaiCliPlugin<MyPluginConfig> = {
    name: "my-command",
    description: "Description shown in help",
    options: [
        {
            flags: "-o, --output <path>",
            description: "Output path",
            required: true,
        },
        {
            flags: "-v, --verbose",
            description: "Enable verbose output",
        },
    ] satisfies CliOption[],
    run: async (args, config) => {
        // args: parsed CLI arguments { output: string, verbose: boolean }
        // config: MyPluginConfig from hexai.config.ts
        console.log("Output:", args.output);
        console.log("Config:", config);
    },
};
```

2. **Export the plugin**:

```typescript
// src/index.ts
export { cliPlugin, type MyPluginConfig } from "./hexai-plugin";
```

3. **Add peer dependency**:

```json
{
    "peerDependencies": {
        "@hexaijs/cli": "^0.1.0"
    }
}
```

### Plugin Interface

```typescript
interface HexaiCliPlugin<TConfig = unknown> {
    /** Command name (e.g., "my-command" → `hexai my-command`) */
    name: string;

    /** Description shown in help output */
    description: string;

    /** CLI options for this command */
    options: CliOption[];

    /**
     * Entry point called when command runs
     * @param args - Parsed CLI arguments
     * @param config - Plugin configuration from hexai.config.ts
     */
    run: (args: Record<string, unknown>, config: TConfig) => Promise<void>;
}

interface CliOption {
    /** Commander.js-style flag (e.g., "-o, --output <path>") */
    flags: string;

    /** Description shown in help */
    description: string;

    /** Whether this option is required */
    required?: boolean;

    /** Default value */
    defaultValue?: string;
}
```

### Flag Syntax

The `flags` property follows Commander.js conventions:

| Pattern | Meaning | Example |
|---------|---------|---------|
| `-s, --short` | Boolean flag | `-v, --verbose` |
| `-o, --option <value>` | Required value | `-o, --output <path>` |
| `-o, --option [value]` | Optional value | `-c, --config [path]` |

## Error Handling

The CLI provides user-friendly error messages:

### Config Not Found
```
Configuration Error: No hexai config file found...

To use hexai, create a hexai.config.ts file:
export default {
    plugins: [...]
};
```

### Plugin Not Found
```
Plugin Error: Plugin "@hexaijs/plugin-xxx" not found...

Make sure the plugin is installed:
  pnpm add @hexaijs/plugin-xxx
```

### Plugin Export Error
```
Plugin Error: Plugin "@hexaijs/plugin-xxx" does not export "cliPlugin"...
```

## API Reference

The package exports the following for programmatic use:

```typescript
import {
    // Types
    HexaiConfig,
    HexaiCliPlugin,
    CliOption,
    PluginEntry,

    // Config loader
    loadConfig,
    loadConfigFromPath,
    findConfigFile,
    ConfigNotFoundError,
    ConfigLoadError,

    // Plugin loader
    loadPlugin,
    loadPlugins,
    PluginNotFoundError,
    PluginExportError,
    PluginValidationError,

    // CLI
    createProgram,
    main,
} from "@hexaijs/cli";
```

## License

MIT
