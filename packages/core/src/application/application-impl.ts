import EventEmitter from "node:events";

import { C, L } from "ts-toolbelt";

import { ConsumedEventTracker, OutboxEventPublisher } from "@/infra";
import { ObjectRegistry } from "@/utils";
import { isEvent } from "@/helpers";
import { Command, Event, Message } from "@/message";
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

class NullConsumedEventTracker implements ConsumedEventTracker {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    markAsConsumed(name: string, event: Event): Promise<void> {
        return Promise.resolve();
    }
}

class OutboxEventPublisherProxy implements OutboxEventPublisher {
    constructor(
        private eventPublisher: OutboxEventPublisher,
        private causeMessage: Message,
        private reporter: (events: Array<Event>) => void
    ) {}

    public async publish(events: Array<Event>): Promise<void> {
        events.forEach((event) => event.setPropagation(this.causeMessage));
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
    SecurityContext = any,
    TAuthenticator extends Authenticator = Authenticator<any, SecurityContext>,
> implements Application<Ctx, Cmds, Events, SecurityContext, TAuthenticator>
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
        private securityContext?: SecurityContext,
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

        const securityContext = await this.resolveSecurityContext();
        await this.authFilters.createFrom(
            commandClass,
            securityContext,
            command
        );
    }

    private async resolveSecurityContext(): Promise<SecurityContext> {
        if (this.securityContext) {
            return this.securityContext;
        }

        if (this.authFactor && this.authenticator) {
            return await this.authenticator(this.authFactor);
        }

        throw new Error("security context or auth factor must be provided.");
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
        const getOutboxEventPublisher = () => {
            const publisher = this.context.getOutboxEventPublisher();

            return new OutboxEventPublisherProxy(
                publisher,
                causeMessage,
                (events) => this.reportEventsPublished(causeMessage, events)
            );
        };

        return new Proxy(this.context, {
            get: (target, prop) => {
                if (prop === "getOutboxEventPublisher") {
                    return getOutboxEventPublisher;
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

        const errorReport = ErrorReport.duringExecutionOf(request, error);
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
                ErrorReport.duringHandlingOf(event, error),
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

    public withSecurityContext(
        securityContext: SecurityContext
    ): ApplicationImpl<Ctx, Cmds, Events, SecurityContext, TAuthenticator> {
        return this.cloneWithSecurityContext(securityContext);
    }

    private cloneWithSecurityContext(
        securityContext: SecurityContext
    ): ApplicationImpl<Ctx, Cmds, Events, SecurityContext, TAuthenticator> {
        return new ApplicationImpl(
            this.context,
            this.useCaseFactories,
            this.eventHandlerFactories,
            this.consumedEventTracker,
            this.authFilters,
            this.authenticator,
            securityContext
        );
    }

    public withAuthFactor(
        factor: AuthFactorOf<TAuthenticator>
    ): ApplicationImpl<Ctx, Cmds, Events, SecurityContext, TAuthenticator> {
        if (!this.authenticator) {
            throw new Error(
                "authenticator must be provided in order to authenticate."
            );
        }

        return this.cloneWithAuthFactor(factor);
    }

    private cloneWithAuthFactor(
        factor: AuthFactorOf<TAuthenticator>
    ): ApplicationImpl<Ctx, Cmds, Events, SecurityContext, TAuthenticator> {
        return new ApplicationImpl<
            Ctx,
            Cmds,
            Events,
            SecurityContext,
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
