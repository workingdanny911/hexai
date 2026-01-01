export {
    type ConfigSpec,
    type InferSpecType,
    type InferConfigType,
    isConfigSpec,
} from "./config-spec";

export { ConfigValidationError } from "./errors";

export { defineConfig, type ConfigOptions } from "./define-config";
export * from "./load-env-files";

export {
    EnvSpec,
    env,
    envOptional,
    envNumber,
    envNumberOptional,
    envBoolean,
    envJson,
    envJsonOptional,
} from "./env-spec";
export { DatabaseConfig } from "./database-config";
