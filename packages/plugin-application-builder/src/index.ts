export { generateApplicationBuilder } from "./main.js";
export { BuildPluginConfig } from "./config.js";
export type {
    GenerateApplicationBuilderOptions,
} from "./main.js";
export type {
    OutputModuleSpecifiers,
    RawBuildPluginConfig,
} from "./config.js";
export {
    CommandHandlerMarker,
    EventHandlerMarker,
    QueryHandlerMarker,
    type EventHandlerOptions,
} from "./decorators/index.js";
export {
    DuplicateCommandHandlerError,
    DuplicateEventHandlerError,
    DuplicateQueryHandlerError,
} from "./errors.js";
export { cliPlugin, type ApplicationBuilderPluginConfig } from "./hexai-plugin.js";
