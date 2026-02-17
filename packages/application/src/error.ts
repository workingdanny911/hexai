import { Message } from "@hexaijs/core";

import { EventHandler } from "./event-handler";
import { CommandHandler } from "./command-handler";
import { QueryHandler } from "./query-handler";

interface ApplicationErrorParams {
    code?: string;
    message?: string;
    cause?: Error;
    data?: Record<string, any>;
}

export class ApplicationError extends Error {
    public readonly code?: string;
    public readonly data: Record<string, any>;

    constructor(params: ApplicationErrorParams) {
        super(params.message, {
            cause: params.cause,
        });
        this.code = params.code;
        this.data = params.data || {};
    }
}

export class HandlerNotFound extends ApplicationError {
    name = "HandlerNotFound";
}

interface BaseErrorTransformingContext {
    message: Message;
}

interface CommandHandlingErrorTransformingContext extends BaseErrorTransformingContext {
    securityContext: unknown;
    handler: CommandHandler;
}

interface EventHandlingErrorTransformingContext extends BaseErrorTransformingContext {
    message: Message;
    handler: EventHandler;
}

interface QueryHandlingErrorTransformingContext extends BaseErrorTransformingContext {
    handler: QueryHandler;
}

export type ApplicationErrorTransformingContext =
    | BaseErrorTransformingContext
    | CommandHandlingErrorTransformingContext
    | QueryHandlingErrorTransformingContext
    | EventHandlingErrorTransformingContext;

export type ApplicationErrorTransformer = (
    error: Error,
    context: ApplicationErrorTransformingContext
) => ApplicationError;

export const ApplicationErrorFactory = {
    handlerNotFound(message: Message) {
        return new HandlerNotFound({
            message: `handler for '${message.getMessageType()}' is not found`,
            data: {
                message,
            },
        });
    },
};
