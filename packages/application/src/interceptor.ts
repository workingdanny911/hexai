import type { Message } from "@hexaijs/core";
import type { Command } from "./command";
import type { Query } from "./query";
import type { Result } from "./application";

// =============================================================================
// Interception Context (Discriminated Union)
// =============================================================================

export interface CommandInterceptionContext {
    readonly intent: "command";
    readonly message: Command;
    metadata: Record<string | symbol, unknown>;
}

export interface QueryInterceptionContext {
    readonly intent: "query";
    readonly message: Query;
    metadata: Record<string | symbol, unknown>;
}

export interface EventInterceptionContext {
    readonly intent: "event";
    readonly message: Message;
    metadata: Record<string | symbol, unknown>;
}

export type InterceptionContext =
    | CommandInterceptionContext
    | QueryInterceptionContext
    | EventInterceptionContext;

// =============================================================================
// Functional Interceptor Types
// =============================================================================

export type CommandInterceptor = (
    ctx: CommandInterceptionContext,
    next: () => Promise<Result<unknown>>
) => Promise<Result<unknown>>;

export type QueryInterceptor = (
    ctx: QueryInterceptionContext,
    next: () => Promise<Result<unknown>>
) => Promise<Result<unknown>>;

export type EventInterceptor = (
    ctx: EventInterceptionContext,
    next: () => Promise<Result<unknown>>
) => Promise<Result<unknown>>;

export type Interceptor = (
    ctx: InterceptionContext,
    next: () => Promise<Result<unknown>>
) => Promise<Result<unknown>>;
