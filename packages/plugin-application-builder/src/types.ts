interface HandlerMetadataBase {
    type: string;
    handlerPath: string;
    handlerClassName: string;
}

export interface CommandHandlerMetadata extends HandlerMetadataBase {
    type: "command";
    commandPath: string;
    commandClassName: string;
}

export interface EventHandlerMetadata extends HandlerMetadataBase {
    type: "event";
    eventHandlerOptions: Record<string, any>;
}

export interface QueryHandlerMetadata extends HandlerMetadataBase {
    type: "query";
    queryPath: string;
    queryClassName: string;
}

export type HandlerMetadata = CommandHandlerMetadata | EventHandlerMetadata | QueryHandlerMetadata;
