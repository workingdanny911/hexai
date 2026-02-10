import { AsyncLocalStorage } from "node:async_hooks";

import type { MessageTrace } from "@hexaijs/core";

interface ExecutionScopeData {
    securityContext?: unknown;
    correlation?: MessageTrace;
    causation?: MessageTrace;
}

export interface ExecutionScopeSnapshot {
    readonly securityContext?: unknown;
    readonly correlation?: MessageTrace;
    readonly causation?: MessageTrace;
}

export class ExecutionScope {
    private static storage = new AsyncLocalStorage<ExecutionScopeData>();

    static run<T>(initialData: Partial<ExecutionScopeData>, fn: () => Promise<T>): Promise<T>;
    static run<T>(initialData: Partial<ExecutionScopeData>, fn: () => T): T;
    static run<T>(
        initialData: Partial<ExecutionScopeData>,
        fn: () => T,
    ): T {
        const parent = this.current();

        const data: ExecutionScopeData = {
            securityContext: Object.prototype.hasOwnProperty.call(initialData, "securityContext")
                ? initialData.securityContext
                : parent?.securityContext,
            correlation: Object.prototype.hasOwnProperty.call(initialData, "correlation")
                ? initialData.correlation
                : parent?.correlation,
            causation: Object.prototype.hasOwnProperty.call(initialData, "causation")
                ? initialData.causation
                : parent?.causation,
        };

        return this.storage.run(data, fn);
    }

    static current(): ExecutionScopeData | undefined {
        return this.storage.getStore();
    }

    static getSecurityContext<T = unknown>(): T | undefined {
        return this.current()?.securityContext as T | undefined;
    }

    static requireSecurityContext<T = unknown>(): T {
        const ctx = this.getSecurityContext<T>();
        if (ctx === undefined) {
            throw new Error("No security context in current execution scope");
        }
        return ctx;
    }

    static getCorrelation(): MessageTrace | undefined {
        return this.current()?.correlation;
    }

    static getCausation(): MessageTrace | undefined {
        return this.current()?.causation;
    }

    static snapshot(): ExecutionScopeSnapshot | undefined {
        const current = this.current();
        if (!current) return undefined;
        return Object.freeze({
            securityContext: current.securityContext,
            correlation: current.correlation,
            causation: current.causation,
        });
    }

    static restore<T>(snapshot: ExecutionScopeSnapshot, fn: () => Promise<T>): Promise<T>;
    static restore<T>(snapshot: ExecutionScopeSnapshot, fn: () => T): T;
    static restore<T>(
        snapshot: ExecutionScopeSnapshot,
        fn: () => T,
    ): T {
        return this.storage.run(
            {
                securityContext: snapshot.securityContext,
                correlation: snapshot.correlation,
                causation: snapshot.causation,
            },
            fn,
        );
    }
}
