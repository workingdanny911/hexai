export { generateApplicationBuilder } from "./main.js";
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
