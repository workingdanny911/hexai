import EventEmitter from "node:events";
import { C, L } from "ts-toolbelt";
import { Command, Event, Message } from "Hexai/message";
import { ConsumedEventTracker, EventPublisher } from "Hexai/infra";
import { ObjectRegistry } from "Hexai/utils";

import { UseCase } from "./use-case";
import {
    EventHandler,
    EventHandlerFactory,
    EventHandlerMeta,
} from "./event-handler";
import { BaseApplicationContext } from "./base-application-context";
import { Authenticator, AuthFilter } from "./auth";
import {
    Application,
    ApplicationEvent,
    ApplicationEventListener,
    AuthFactorOf,
    CommandExecutionResult,
    ErrorReport,
    EventHandlingResult,
    FindResponseType,
    HandlerExecutionResults,
    IfSupports,
} from "./application";
import {
    AuthErrorResponse,
    authErrorResponse,
    ErrorResponse,
    UnknownErrorResponse,
    unknownErrorResponse,
} from "./error-response";
import { UseCaseFactory } from "./common-types";
import { isEvent } from "Hexai/helpers";

class NullConsumedEventTracker implements ConsumedEventTracker {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    markAsConsumed(name: string, event: Event): Promise<void> {
        return Promise.resolve();
    }
}

class EventPublisherProxy implements EventPublisher {
    constructor(
        private eventPublisher: EventPublisher,
        private causeMessage: Message,
        private reporter: (events: Array<Event>) => void
    ) {}

    public async publish(events: Array<Event>): Promise<void> {
        events.forEach((event) => event.setCause(this.causeMessage));
        await this.eventPublisher.publish(events);
        this.reporter(events);
    }
}

class UnknownCommandError extends Error {
    constructor(command: Command) {
        super(`the application does not support '${command.constructor}'.`);
    }
}

export class ApplicationImpl<
    Ctx extends BaseApplicationContext,
    Cmds extends L.List,
    Events extends Event,
    AuthPrincipal = any,
    TAuthenticator extends Authenticator = Authenticator<any, AuthPrincipal>,
> implements Application<Ctx, Cmds, Events, AuthPrincipal, TAuthenticator>
{
    private eventsPublished = new WeakMap<Message, Array<Event>>();
    protected eventEmitter = new EventEmitter();

    protected constructor(
        protected context: Ctx,
        private useCaseFactories: ObjectRegistry<C.Class, UseCaseFactory<Ctx>>,
        private eventHandlerFactories: ObjectRegistry<
            EventHandlerMeta,
            EventHandlerFactory<Ctx>
        >,
        private consumedEventTracker: ConsumedEventTracker = new NullConsumedEventTracker(),
        private authFilters: ObjectRegistry<
            C.Class,
            AuthFilter
        > = new ObjectRegistry(),
        private authenticator?: TAuthenticator,
        private authPrincipal?: AuthPrincipal,
        private authFactor?: AuthFactorOf<TAuthenticator>
    ) {}

    public getContext(): Ctx {
        return this.context;
    }

    public async execute<I extends Command>(
        request: IfSupports<Cmds, I>
    ): Promise<FindResponseType<Cmds, I> | ErrorResponse> {
        try {
            await this.checkAuth(request);
        } catch (e) {
            return this.authErrorAsResponse(e as Error, request);
        }

        let response: unknown;
        try {
            response = await this.executeCommand(request);
        } catch (e) {
            if (e instanceof UnknownCommandError) {
                return {
                    errorType: "SYSTEM_ERROR",
                    message: e.message,
                };
            }

            return this.uncaughtErrorAsResponse(e as Error, request);
        }

        await this.handleEventsInternally(this.getEventsPublished(request));

        return response as any;
    }

    protected async handleEventsInternally(
        events: Array<Event>
    ): Promise<void> {
        for (const event of events) {
            setTimeout(() => this.handle(event as Events), 0);
        }
    }

    private async checkAuth(command: Command): Promise<void> {
        const commandClass = command.constructor as C.Class;
        if (!this.authFilters.isRegistered(commandClass)) {
            return;
        }

        const authPrincipal = await this.resolveAuthPrincipal();
        await this.authFilters.createFrom(commandClass, authPrincipal, command);
    }

    private async resolveAuthPrincipal(): Promise<AuthPrincipal> {
        if (this.authPrincipal) {
            return this.authPrincipal;
        }

        if (this.authFactor && this.authenticator) {
            return await this.authenticator(this.authFactor);
        }

        throw new Error("auth principal or factor must be provided.");
    }

    private authErrorAsResponse(
        error: Error,
        request: Command
    ): AuthErrorResponse {
        const result = new CommandExecutionResult(request) as any;
        const response = authErrorResponse(error.message);

        result.setResponse(response);
        this.notify(["command-execution", result]);

        return response;
    }

    private async executeCommand(request: Command): Promise<unknown> {
        const result = new CommandExecutionResult(request) as any;
        const useCase = this.makeUseCase(request);

        const response = await useCase.execute(request);

        result.setResponse(response);
        result.setEventsPublished(this.getEventsPublished(request));
        this.notify(["command-execution", result]);

        return response;
    }

    private makeUseCase(request: Command): UseCase {
        try {
            return this.useCaseFactories.createFrom(
                request.constructor as C.Class,
                this.getContextProxy(request)
            );
        } catch (e) {
            if (e instanceof ObjectRegistry.EntryNotFound) {
                throw new UnknownCommandError(request);
            }

            throw e;
        }
    }

    private getContextProxy(causeMessage: Message): Ctx {
        const getEventPublisher = () => {
            const publisher = this.context.getEventPublisher();

            return new EventPublisherProxy(publisher, causeMessage, (events) =>
                this.reportEventsPublished(causeMessage, events)
            );
        };

        return new Proxy(this.context, {
            get: (target, prop) => {
                if (prop === "getEventPublisher") {
                    return getEventPublisher;
                }

                return target[prop as keyof Ctx];
            },
        });
    }

    private uncaughtErrorAsResponse(
        error: Error,
        request: Command
    ): UnknownErrorResponse {
        const result = new CommandExecutionResult(request) as any;
        const response = unknownErrorResponse(error.message);
        result.setResponse(response);
        result.setEventsPublished(this.getEventsPublished(request));
        this.notify(["command-execution", result]);

        const errorReport = new ErrorReport(
            error,
            "command-execution",
            request
        );
        this.notify(["uncaught-exception", errorReport]);

        return response;
    }

    public async handle(event: Events): Promise<void> {
        this.validateEvent(event);

        const results = await this.doHandle(event);
        this.reportEventHandlingResult(event, results);
        await this.handleEventsInternally(this.getEventsPublished(event));
    }

    private validateEvent(event: Event): void {
        if (!isEvent(event)) {
            throw new Error(
                "parameter 'event' must be an instance of 'Event'."
            );
        }
    }

    private async doHandle(event: Event): Promise<HandlerExecutionResults> {
        const eventHandlerMetas = this.eventHandlerFactories.keys();
        const executions = eventHandlerMetas.map(async (meta) => {
            const error = await this.executeEventHandler(meta, event);

            return {
                handler: meta,
                error,
            };
        });

        return await Promise.all(executions);
    }

    private async executeEventHandler(
        meta: EventHandlerMeta,
        event: Event
    ): Promise<Error | undefined> {
        const handler = this.eventHandlerFactories.createFrom<EventHandler>(
            meta,
            this.getContextProxy(event)
        );
        let error: Error | undefined;

        try {
            if (meta.idempotent) {
                await this.executeIdempotentEventHandler(
                    meta.name,
                    handler,
                    event
                );
            } else {
                await handler.handle(event);
            }
        } catch (e) {
            error = e as Error;

            this.notify([
                "uncaught-exception",
                new ErrorReport(error, "event-handling", event),
            ]);
        }

        return error;
    }

    private async executeIdempotentEventHandler(
        idempotencyKey: string,
        handler: EventHandler,
        event: Event
    ): Promise<void> {
        await this.context.getUnitOfWork().wrap(async () => {
            await Promise.all([
                this.consumedEventTracker.markAsConsumed(idempotencyKey, event),
                handler.handle(event),
            ]);
        });
    }

    private reportEventHandlingResult(
        event: Event,
        results: HandlerExecutionResults
    ): void {
        const result = new EventHandlingResult(event) as any;
        const eventsPublished = this.getEventsPublished(event);
        result.setHandlerExecutionResults(results);
        result.setEventsPublished(eventsPublished);
        this.notify(["event-handling", result]);
    }

    public withAuthPrincipal(
        principal: AuthPrincipal
    ): ApplicationImpl<Ctx, Cmds, Events, AuthPrincipal, TAuthenticator> {
        return this.cloneWithAuthPrincipal(principal);
    }

    private cloneWithAuthPrincipal(
        principal: AuthPrincipal
    ): ApplicationImpl<Ctx, Cmds, Events, AuthPrincipal, TAuthenticator> {
        return new ApplicationImpl(
            this.context,
            this.useCaseFactories,
            this.eventHandlerFactories,
            this.consumedEventTracker,
            this.authFilters,
            this.authenticator,
            principal
        );
    }

    public withAuthFactor(
        factor: AuthFactorOf<TAuthenticator>
    ): ApplicationImpl<Ctx, Cmds, Events, AuthPrincipal, TAuthenticator> {
        if (!this.authenticator) {
            throw new Error(
                "authenticator must be provided in order to authenticate."
            );
        }

        return this.cloneWithAuthFactor(factor);
    }

    private cloneWithAuthFactor(
        factor: AuthFactorOf<TAuthenticator>
    ): ApplicationImpl<Ctx, Cmds, Events, AuthPrincipal, TAuthenticator> {
        return new ApplicationImpl<
            Ctx,
            Cmds,
            Events,
            AuthPrincipal,
            TAuthenticator
        >(
            this.context,
            this.useCaseFactories,
            this.eventHandlerFactories,
            this.consumedEventTracker,
            this.authFilters,
            this.authenticator,
            undefined,
            factor
        );
    }

    public listen(listener: ApplicationEventListener): void {
        this.eventEmitter.on("_", listener);
    }

    public removeListener(listener: ApplicationEventListener): void {
        this.eventEmitter.removeListener("_", listener);
    }

    private notify(appEvent: ApplicationEvent): void {
        this.eventEmitter.emit("_", appEvent);
    }

    private reportEventsPublished(cause: Message, events: Array<Event>): void {
        this.eventsPublished.set(cause, events);
    }

    protected getEventsPublished(cause: Message): Array<Event> {
        return this.eventsPublished.get(cause) ?? [];
    }
}
