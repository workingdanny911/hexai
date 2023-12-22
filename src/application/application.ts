import { L, N } from "ts-toolbelt";

import { Command, Event, Message } from "Hexai/message";
import { BaseApplicationContext } from "./base-application-context";
import { Authenticator } from "./auth";
import { EventHandlerMeta } from "./event-handler";
import {
    ErrorResponse,
    isErrorResponse,
} from "Hexai/application/error-response";

export type ApplicationEvent =
    | ["command-execution", CommandExecutionResult]
    | ["uncaught-exception", ErrorReport]
    | ["event-handling", EventHandlingResult];

export interface ApplicationEventListener {
    (event: ApplicationEvent): void;
}

export type FindResponseType<
    IOPairs extends L.List,
    I,
    Index extends number = 0,
> = N.Lower<Index, 0> extends 1
    ? never
    : N.GreaterEq<Index, L.Length<IOPairs>> extends 1
      ? never
      : IOPairs[Index] extends [I, infer O]
        ? O
        : FindResponseType<IOPairs, I, N.Add<Index, 1>>;

export type IfSupports<
    IOPairs extends L.List,
    I extends Command,
> = IOPairs extends L.List<[infer R, any]> ? (I extends R ? I : never) : never;

export type AuthFactorOf<A extends Authenticator> = A extends Authenticator<
    infer Factor
>
    ? Factor
    : never;

export type AuthPrincipalOf<A extends Authenticator> = A extends Authenticator<
    any,
    infer Principal
>
    ? Principal
    : never;

export interface Application<
    Ctx extends BaseApplicationContext,
    Cmds extends L.List,
    Events extends Event,
    AuthPrincipal = any,
    TAuthenticator extends Authenticator = Authenticator<any, AuthPrincipal>,
> {
    getContext(): Ctx;
    execute<I extends Command>(
        command: IfSupports<Cmds, I>
    ): Promise<FindResponseType<Cmds, I> | ErrorResponse>;
    handle(event: Events): Promise<void>;
    withAuthFactor(
        factor: AuthFactorOf<TAuthenticator>
    ): Application<Ctx, Cmds, Events, AuthPrincipal>;
    withAuthPrincipal(
        principal: AuthPrincipal
    ): Application<Ctx, Cmds, Events, AuthPrincipal>;
    listen(listener: ApplicationEventListener): void;
    removeListener(listener: ApplicationEventListener): void;
}

export class CommandExecutionResult {
    private response: unknown;
    private eventsPublished: Array<Event> = [];

    constructor(private command: Command) {}

    public getCommand(): Command {
        return this.command;
    }

    public isError(): boolean {
        return isErrorResponse(this.response);
    }

    public isSuccessful(): boolean {
        return !this.isError();
    }

    public getResponse(): unknown {
        return this.response;
    }

    private setResponse(response: unknown): void {
        this.response = response;
    }

    public getEventsPublished(): Array<Event> {
        return this.eventsPublished;
    }

    private setEventsPublished(events: Array<Event>): void {
        this.eventsPublished = events;
    }
}

export class ErrorReport {
    private timestamp = new Date();

    private constructor(
        private error: Error,
        public during: "command-execution" | "event-handling",
        private message: Message
    ) {}

    public static duringExecutionOf(
        command: Command,
        error: Error
    ): ErrorReport {
        return new ErrorReport(error, "command-execution", command);
    }

    public static duringHandlingOf(event: Event, error: Error): ErrorReport {
        return new ErrorReport(error, "event-handling", event);
    }

    public occurredDuring(): "command-execution" | "event-handling" {
        return this.during;
    }

    public getError(): Error {
        return this.error;
    }

    public getCause(): Message {
        return this.message;
    }

    public ocurredAt(): Date {
        return this.timestamp;
    }
}

export type HandlerExecutionResults = Array<{
    handler: EventHandlerMeta;
    error?: Error;
}>;

export class EventHandlingResult {
    private eventsPublished!: Array<Event>;
    private handlerExecutionResults!: Array<{
        handler: EventHandlerMeta;
        error?: Error;
    }>;

    constructor(private event: Event) {}

    public getEvent(): Event {
        return this.event;
    }

    public getEventsPublished(): Array<Event> {
        return this.eventsPublished;
    }

    private setEventsPublished(events: Array<Event>): void {
        this.eventsPublished = events;
    }

    public getHandlerExecutionResults(): Array<{
        handler: EventHandlerMeta;
        error?: Error;
    }> {
        return this.handlerExecutionResults;
    }

    private setHandlerExecutionResults(
        results: Array<{
            handler: EventHandlerMeta;
            error?: Error;
        }>
    ): void {
        this.handlerExecutionResults = results;
    }

    public hasFailedHandlers(): boolean {
        return this.handlerExecutionResults.some((result) => !!result.error);
    }

    public isAllHandlersSuccessful(): boolean {
        return !this.hasFailedHandlers();
    }
}
