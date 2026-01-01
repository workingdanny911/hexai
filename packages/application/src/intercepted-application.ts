import { Message } from "@hexaijs/core";

import { Application, EventHandlingResult, Result } from "./application";
import { Command } from "./command";
import { Query } from "./query";
import {
    CommandInterceptionContext,
    QueryInterceptionContext,
    EventInterceptionContext,
    InterceptionContext,
    CommandInterceptor,
    QueryInterceptor,
    EventInterceptor,
    Interceptor,
} from "./interceptor";

type Executor<T = unknown> = () => Promise<Result<T>>;

export class InterceptedApplicationBuilder {
    private commandInterceptors: CommandInterceptor[] = [];
    private queryInterceptors: QueryInterceptor[] = [];
    private eventInterceptors: EventInterceptor[] = [];
    private commonInterceptors: Interceptor[] = [];

    constructor(private delegate: Application) {}

    withCommandInterceptor(interceptor: CommandInterceptor): this {
        this.commandInterceptors.push(interceptor);
        return this;
    }

    withQueryInterceptor(interceptor: QueryInterceptor): this {
        this.queryInterceptors.push(interceptor);
        return this;
    }

    withEventInterceptor(interceptor: EventInterceptor): this {
        this.eventInterceptors.push(interceptor);
        return this;
    }

    withInterceptor(interceptor: Interceptor): this {
        this.commonInterceptors.push(interceptor);
        return this;
    }

    build(): Application {
        return new InterceptedApplication(
            this.delegate,
            this.commandInterceptors,
            this.queryInterceptors,
            this.eventInterceptors,
            this.commonInterceptors
        );
    }
}

export class InterceptedApplication implements Application {
    static wrap(delegate: Application): InterceptedApplicationBuilder {
        return new InterceptedApplicationBuilder(delegate);
    }

    constructor(
        private delegate: Application,
        private commandInterceptors: CommandInterceptor[],
        private queryInterceptors: QueryInterceptor[],
        private eventInterceptors: EventInterceptor[],
        private commonInterceptors: Interceptor[]
    ) {}

    public async executeCommand<T = unknown>(
        command: Command
    ): Promise<Result<T>> {
        const context: CommandInterceptionContext = {
            intent: "command",
            message: command,
            metadata: {},
        };

        const finalHandler: Executor<T> = () =>
            this.delegate.executeCommand(command);

        const chain = this.buildInterceptorChain(
            context,
            finalHandler,
            this.commandInterceptors
        );
        return chain();
    }

    public async executeQuery<T = unknown>(query: Query): Promise<Result<T>> {
        const context: QueryInterceptionContext = {
            intent: "query",
            message: query,
            metadata: {},
        };

        const finalHandler: Executor<T> = () =>
            this.delegate.executeQuery(query);

        const chain = this.buildInterceptorChain(
            context,
            finalHandler,
            this.queryInterceptors
        );
        return chain();
    }

    public async handleEvent(
        event: Message
    ): Promise<Result<EventHandlingResult>> {
        const context: EventInterceptionContext = {
            intent: "event",
            message: event,
            metadata: {},
        };

        const finalHandler: Executor<EventHandlingResult> = () =>
            this.delegate.handleEvent(event);

        const chain = this.buildInterceptorChain(
            context,
            finalHandler,
            this.eventInterceptors
        );
        return chain();
    }

    private buildInterceptorChain<
        TContext extends InterceptionContext,
        TResult,
    >(
        context: TContext,
        finalHandler: Executor<TResult>,
        specificInterceptors: Array<
            (
                ctx: TContext,
                next: () => Promise<Result<unknown>>
            ) => Promise<Result<unknown>>
        >
    ): Executor<TResult> {
        // Combine common interceptors with specific interceptors
        // Common interceptors run first (outer), then specific interceptors (inner)
        const allInterceptors: Array<
            (
                ctx: TContext,
                next: () => Promise<Result<unknown>>
            ) => Promise<Result<unknown>>
        > = [
            ...(this.commonInterceptors as Array<
                (
                    ctx: TContext,
                    next: () => Promise<Result<unknown>>
                ) => Promise<Result<unknown>>
            >),
            ...specificInterceptors,
        ];

        let wrappedHandler: Executor<TResult> = finalHandler;

        // Build chain from inside out (reverse order)
        for (let i = allInterceptors.length - 1; i >= 0; i--) {
            const interceptor = allInterceptors[i];
            const nextHandler = wrappedHandler;
            wrappedHandler = (() => {
                const guardedNext = this.createSingleCallGuard(nextHandler);
                return interceptor(context, guardedNext);
            }) as Executor<TResult>;
        }

        return wrappedHandler;
    }

    private createSingleCallGuard<TExecutor extends () => Promise<any>>(
        executor: TExecutor
    ): TExecutor {
        let hasBeenCalled = false;

        return (() => {
            if (hasBeenCalled) {
                throw new Error(
                    "next() can only be called once in an interceptor"
                );
            }
            hasBeenCalled = true;
            return executor();
        }) as TExecutor;
    }
}
