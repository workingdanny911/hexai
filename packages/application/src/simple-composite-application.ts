import { Message, UnitOfWork } from "@hexaijs/core";
import {
    Application,
    ApplicationBuilder,
    ErrorResult,
    EventHandlingResult,
    Result,
    SuccessResult,
} from "./application.js";
import { ApplicationError, ApplicationErrorFactory } from "./error.js";
import { fanOut } from "./fan-out.js";
import { Command } from "./command.js";
import { Query } from "./query.js";

export class SimpleCompositeApplication implements Application {
    private unitOfWork?: UnitOfWork;

    constructor(
        private applicationByCommandPrefix: Record<string, Application>,
        unitOfWork?: UnitOfWork
    ) {
        this.unitOfWork = unitOfWork;
    }

    setUnitOfWork(unitOfWork: UnitOfWork) {
        this.unitOfWork = unitOfWork;
    }

    public async executeCommand<C extends Command>(
        command: C
    ): Promise<Result<C['ResultType']>> {
        const handler = this.findAppropriateApplication(
            command.getMessageType()
        );

        if (handler) {
            return handler.executeCommand(command);
        }

        return new ErrorResult(
            ApplicationErrorFactory.handlerNotFound(command)
        );
    }

    public async executeQuery<Q extends Query>(
        query: Q
    ): Promise<Result<Q['ResultType']>> {
        const handler = this.findAppropriateApplication(query.getMessageType());

        if (handler) {
            return handler.executeQuery(query);
        }

        return new ErrorResult(ApplicationErrorFactory.handlerNotFound(query));
    }

    private findAppropriateApplication(
        messageType: string
    ): Application | undefined {
        const prefixes = Object.keys(this.applicationByCommandPrefix);
        for (const prefix of prefixes) {
            if (messageType.startsWith(prefix)) {
                return this.applicationByCommandPrefix[prefix];
            }
        }
    }

    public async handleEvent(
        event: Message
    ): Promise<Result<EventHandlingResult>> {
        if (!this.unitOfWork) {
            throw new Error(
                "Unit of work not set for CompositeApplication. Set it using setUnitOfWork() method."
            );
        }

        const apps = Object.values(this.applicationByCommandPrefix);
        const throwIfError = async (app: Application) => {
            const result = await app.handleEvent(event);
            if (result.isError) {
                throw result;
            }
        };

        // The application failure must reject the scope callback so the unit
        // of work rolls back; returning it from inside the scope would commit
        // the writes of the applications that succeeded. It is rejected as a
        // fresh Error because a unit of work may not treat a falsy rejection
        // as a failure (Postgres does not abort a nested scope on
        // `undefined`). Only that failure becomes an ErrorResult; unit-of-work
        // failures reject as before.
        let applicationFailure: CompositeEventHandlingFailure | undefined;
        try {
            await this.unitOfWork.scope(async () => {
                try {
                    await fanOut(apps, throwIfError);
                } catch (failure) {
                    applicationFailure = new CompositeEventHandlingFailure(
                        event,
                        failure
                    );
                    throw applicationFailure;
                }
            });
        } catch (error) {
            if (applicationFailure && error === applicationFailure) {
                return toErrorResult(applicationFailure.failure, event);
            }
            throw error;
        }

        return applicationFailure
            ? toErrorResult(applicationFailure.failure, event)
            : new SuccessResult(null);
    }
}

class CompositeEventHandlingFailure extends Error {
    constructor(
        event: Message,
        readonly failure: unknown
    ) {
        super(`Handling event '${event.getMessageType()}' failed`, {
            cause: failure,
        });
        this.name = "CompositeEventHandlingFailure";
    }
}

function toErrorResult(failure: unknown, event: Message): ErrorResult {
    if (isErrorResult(failure)) {
        return failure;
    }
    if (failure instanceof ApplicationError) {
        return new ErrorResult(failure);
    }

    return new ErrorResult(
        ApplicationBuilder.defaultErrorTransformer(toError(failure), {
            message: event,
        })
    );
}

// Duck-typed because applications may come from another installed copy of
// this package, whose ErrorResult is a different class.
function isErrorResult(value: unknown): value is ErrorResult {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const candidate = value as {
        isError?: unknown;
        getOrThrow?: unknown;
    };
    return (
        candidate.isError === true &&
        "error" in candidate &&
        typeof candidate.getOrThrow === "function"
    );
}

// Keeps the original value in the cause chain: structured rejections carry
// fields such as a SQLSTATE `code`, and errors from another realm fail
// `instanceof Error` but still carry their own cause chain.
function toError(failure: unknown): Error {
    if (failure instanceof Error) {
        return failure;
    }

    return new Error(describeFailure(failure), { cause: failure });
}

function describeFailure(failure: unknown): string {
    // Each step may throw (getters, null-prototype objects, revoked proxies);
    // describing a failure must never replace it with a new one.
    try {
        const message = (failure as { message?: unknown } | null | undefined)
            ?.message;
        if (typeof message === "string") {
            return message;
        }
    } catch {
        // Fall through to the next description.
    }
    try {
        return String(failure);
    } catch {
        // Fall through to the next description.
    }
    try {
        return Object.prototype.toString.call(failure);
    } catch {
        return "Unknown failure";
    }
}
