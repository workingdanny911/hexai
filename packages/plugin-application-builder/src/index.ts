export { generateApplicationBuilder } from "./main";
export {
    CommandHandlerMarker,
    EventHandlerMarker,
    QueryHandlerMarker,
    type EventHandlerOptions,
} from "./decorators";
export {
    DuplicateCommandHandlerError,
    DuplicateEventHandlerError,
    DuplicateQueryHandlerError,
} from "./errors";
export { cliPlugin, type ApplicationBuilderPluginConfig } from "./hexai-plugin";
