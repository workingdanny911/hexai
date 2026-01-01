export class DuplicateCommandHandlerError extends Error {
    constructor(commandClassName: string, handlers: string[]) {
        super(
            `Duplicate command handlers for "${commandClassName}": ${handlers.join(", ")}`
        );
        this.name = "DuplicateCommandHandlerError";
    }
}

export class DuplicateEventHandlerError extends Error {
    constructor(eventName: string, handlers: string[]) {
        super(
            `Duplicate event handlers for event "${eventName}": ${handlers.join(", ")}`
        );
        this.name = "DuplicateEventHandlerError";
    }
}

export class DuplicateQueryHandlerError extends Error {
    constructor(queryClassName: string, handlers: string[]) {
        super(
            `Duplicate query handlers for "${queryClassName}": ${handlers.join(", ")}`
        );
        this.name = "DuplicateQueryHandlerError";
    }
}

export class MessageClassNotFoundError extends Error {
    constructor(messageClassName: string, filePath: string) {
        super(
            `Cannot find "${messageClassName}" - not imported and not defined in "${filePath}"`
        );
        this.name = "MessageClassNotFoundError";
    }
}
