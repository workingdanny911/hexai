import { Message, MessageClass } from "@hexaijs/core";

import { AbstractApplicationContext } from "./abstract-application-context";
import { CommandHandler } from "./command-handler";
import { Command } from "./command";
import { QueryHandler } from "./query-handler";
import { Query } from "./query";
import {
    ApplicationError,
    ApplicationErrorFactory,
    ApplicationErrorTransformer,
} from "./error";
import { EventHandler } from "./event-handler";
import {
    CommandInterceptor,
    QueryInterceptor,
    EventInterceptor,
    Interceptor,
} from "./interceptor";
import { InterceptedApplication } from "./intercepted-application";
import { SuccessResult, ErrorResult } from "./result";
import type { Result } from "./result";

export { SuccessResult, ErrorResult };
export type { Result };

type Factory<T> = () => T;

type CommandHandlerFactory = Factory<CommandHandler>;

type QueryHandlerFactory = Factory<QueryHandler>;

interface CommandClass extends MessageClass {
    new (...args: any[]): Command;
}

interface QueryClass extends MessageClass {
    new (...args: any[]): Query;
}

class TypeBasedHandlerRegistry<
    TMessage extends Message,
    TMessageClass extends MessageClass,
    THandler,
> {
    private handlers: Record<string, Factory<THandler>> = {};

    register(messageClass: TMessageClass, factory: Factory<THandler>): void {
        this.handlers[messageClass.getType()] = factory;
    }

    find(message: TMessage | TMessageClass): Factory<THandler> | undefined {
        if ("getMessageType" in message) {
            return this.handlers[message.getMessageType()];
        } else {
            return this.handlers[(message as TMessageClass).getType()];
        }
    }
}

type CommandHandlerRegistry = TypeBasedHandlerRegistry<
    Command,
    CommandClass,
    CommandHandler
>;
type QueryHandlerRegistry = TypeBasedHandlerRegistry<
    Query,
    QueryClass,
    QueryHandler
>;

export type EventHandlingResult = unknown;

export interface CommandDispatcher {
    executeCommand<C extends Command>(command: C): Promise<Result<C['ResultType']>>;
}

export interface QueryDispatcher {
    executeQuery<Q extends Query>(query: Q): Promise<Result<Q['ResultType']>>;
}

export interface EventDispatcher {
    handleEvent(event: Message): Promise<Result<EventHandlingResult>>;
}

export interface Application
    extends CommandDispatcher, QueryDispatcher, EventDispatcher {}

class GenericApplication implements Application {
    private constructor(
        private applicationContext: AbstractApplicationContext,
        private commandHandlers: CommandHandlerRegistry,
        private queryHandlers: QueryHandlerRegistry,
        private eventHandlers: Array<EventHandler>,
        private errorTransformer: ApplicationErrorTransformer
    ) {}

    public async executeCommand<C extends Command>(
        command: C
    ): Promise<Result<C['ResultType']>> {
        try {
            const result = await this.doExecuteCommand<C['ResultType']>(command);
            return new SuccessResult(result);
        } catch (e) {
            let error: ApplicationError;

            if (e instanceof ApplicationError) {
                error = e;
            } else {
                error = this.errorTransformer(e as Error, {
                    message: command,
                });
            }

            return new ErrorResult(error);
        }
    }

    public async handleEvent(
        event: Message
    ): Promise<Result<EventHandlingResult>> {
        const selected = this.eventHandlers.filter((eh) => eh.canHandle(event));

        try {
            await this.applicationContext.enterCommandExecutionScope(
                event,
                async (context) => {
                    await Promise.all(
                        selected.map((eh) => eh.handle(event, context))
                    );
                }
            );
            return new SuccessResult(null);
        } catch (e) {
            if (e instanceof ApplicationError) {
                return new ErrorResult(e);
            }
            return new ErrorResult(
                this.errorTransformer(e as Error, { message: event })
            );
        }
    }

    public async executeQuery<Q extends Query>(
        query: Q
    ): Promise<Result<Q['ResultType']>> {
        try {
            const result = await this.doExecuteQuery<Q['ResultType']>(query);
            return new SuccessResult(result);
        } catch (e) {
            let error: ApplicationError;

            if (e instanceof ApplicationError) {
                error = e;
            } else {
                error = this.errorTransformer(e as Error, {
                    message: query,
                });
            }

            return new ErrorResult(error);
        }
    }

    private async doExecuteCommand<T>(command: Command): Promise<T> {
        const handler = this.getCommandHandler(command);

        try {
            let result: T;
            await this.applicationContext.enterCommandExecutionScope(
                command,
                async (context) => {
                    result = (await handler.execute(command, context)) as unknown as T;
                }
            );
            return result!;
        } catch (e) {
            if (e instanceof ApplicationError) {
                throw e;
            }
            throw this.errorTransformer(e as Error, {
                message: command,
                handler: handler,
            });
        }
    }

    private getCommandHandler(command: Command): CommandHandler {
        const factory = this.commandHandlers.find(command);

        if (!factory) {
            throw ApplicationErrorFactory.handlerNotFound(command);
        }

        return factory();
    }

    private async doExecuteQuery<T>(query: Query): Promise<T> {
        const handler = this.getQueryHandler(query);

        try {
            let result: T;
            await this.applicationContext.enterCommandExecutionScope(
                query,
                async (context) => {
                    result = (await handler.execute(query, context)) as unknown as T;
                }
            );
            return result!;
        } catch (e) {
            if (e instanceof ApplicationError) {
                throw e;
            }
            throw this.errorTransformer(e as Error, {
                message: query,
                handler: handler,
            });
        }
    }

    private getQueryHandler(query: Query): QueryHandler {
        const factory = this.queryHandlers.find(query);

        if (!factory) {
            throw ApplicationErrorFactory.handlerNotFound(query);
        }

        return factory();
    }
}

export class ApplicationBuilder {
    private commandHandlers: CommandHandlerRegistry =
        new TypeBasedHandlerRegistry();
    private queryHandlers: QueryHandlerRegistry =
        new TypeBasedHandlerRegistry();
    private eventHandlers: Array<EventHandler> = [];
    private eventHandlerNames: Set<string> = new Set();
    private applicationContext: AbstractApplicationContext | null = null;
    private errorTransformer: ApplicationErrorTransformer | null = null;
    private commandInterceptors: Array<CommandInterceptor> = [];
    private queryInterceptors: Array<QueryInterceptor> = [];
    private eventInterceptors: Array<EventInterceptor> = [];
    private commonInterceptors: Array<Interceptor> = [];

    public static readonly defaultErrorTransformer: ApplicationErrorTransformer =
        (error, context) => {
            return new ApplicationError({
                message: error.message,
                cause: error,
                data: {
                    context,
                },
            });
        };

    public withCommandHandler(
        commandClass: CommandClass,
        commandHandlerFactory: CommandHandlerFactory
    ): this {
        this.assertNoHandlerRegisteredFor(commandClass);

        this.commandHandlers.register(commandClass, commandHandlerFactory);

        return this;
    }

    private assertNoHandlerRegisteredFor(commandClass: CommandClass) {
        const handler = this.commandHandlers.find(commandClass);

        if (handler) {
            throw new Error(
                `'${commandClass.getType()}' is already paired with '${handler}'`
            );
        }
    }

    public withQueryHandler(
        queryClass: QueryClass,
        queryHandlerFactory: QueryHandlerFactory
    ): this {
        this.assertNoQueryHandlerRegisteredFor(queryClass);

        this.queryHandlers.register(queryClass, queryHandlerFactory);

        return this;
    }

    private assertNoQueryHandlerRegisteredFor(queryClass: QueryClass) {
        const handler = this.queryHandlers.find(queryClass);

        if (handler) {
            throw new Error(
                `'${queryClass.getType()}' is already paired with '${handler}'`
            );
        }
    }

    public withApplicationContext(
        applicationContext: AbstractApplicationContext
    ): this {
        this.applicationContext = applicationContext;

        return this;
    }

    public withErrorTransformer(
        errorTransformer: ApplicationErrorTransformer
    ): this {
        this.errorTransformer = errorTransformer;

        return this;
    }

    public withEventHandler(
        eventHandlerFactory: () => EventHandler,
        eventHandlerName?: string
    ): this {
        if (eventHandlerName) {
            this.assertNoEventHandlerWithSameNameRegistered(eventHandlerName);
            this.eventHandlerNames.add(eventHandlerName);
        }

        this.eventHandlers.push(eventHandlerFactory());

        return this;
    }

    private assertNoEventHandlerWithSameNameRegistered(
        eventHandlerName: string
    ) {
        if (this.eventHandlerNames.has(eventHandlerName)) {
            throw new Error(
                `event handler with name '${eventHandlerName}' is already registered`
            );
        }
    }

    public withCommandInterceptor(interceptor: CommandInterceptor): this {
        this.commandInterceptors.push(interceptor);
        return this;
    }

    public withQueryInterceptor(interceptor: QueryInterceptor): this {
        this.queryInterceptors.push(interceptor);
        return this;
    }

    public withEventInterceptor(interceptor: EventInterceptor): this {
        this.eventInterceptors.push(interceptor);
        return this;
    }

    public withInterceptor(interceptor: Interceptor): this {
        this.commonInterceptors.push(interceptor);
        return this;
    }

    public build(): Application {
        if (this.applicationContext === null) {
            throw new Error(
                "application context is required to build application.\n" +
                    "use .withApplicationContext() to provide application context."
            );
        }

        // @ts-expect-error: constructor of GenericApplication is private
        const coreApp: Application = new GenericApplication(
            this.applicationContext!,
            this.commandHandlers,
            this.queryHandlers,
            this.eventHandlers,
            this.errorTransformer || ApplicationBuilder.defaultErrorTransformer
        );

        const hasInterceptors =
            this.commandInterceptors.length > 0 ||
            this.queryInterceptors.length > 0 ||
            this.eventInterceptors.length > 0 ||
            this.commonInterceptors.length > 0;

        if (hasInterceptors) {
            return new InterceptedApplication(
                coreApp,
                this.commandInterceptors,
                this.queryInterceptors,
                this.eventInterceptors,
                this.commonInterceptors
            );
        }

        return coreApp;
    }
}
