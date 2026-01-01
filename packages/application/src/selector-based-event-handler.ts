import { Message } from "@hexaijs/core";

import { EventHandler } from "./event-handler";

interface Selector {
    method: string;
    predicate(event: Message): boolean;
}

export function When(predicate: (event: Message) => boolean): MethodDecorator {
    return function (target: any, propertyKey: string | symbol) {
        target.constructor.registerSelector({
            method: propertyKey.toString(),
            predicate,
        });
    };
}

export function eventTypeMatches(
    type: string | string[] | RegExp
): (event: Message) => boolean {
    if (Array.isArray(type)) {
        return (event) => type.includes(event.getMessageType());
    } else if (type instanceof RegExp) {
        return (event) => type.test(event.getMessageType());
    }

    return (event) => event.getMessageType() === type;
}

/**
 * Base class for event handlers that use @When decorator for routing.
 *
 * Implements EventHandler interface with selector-based event routing.
 * Uses @When decorator to register predicates that determine which method handles each event.
 *
 * @typeParam E - The event type (extends Message)
 * @typeParam Ctx - The application context type
 */
export class SelectorBasedEventHandler<
    E extends Message = Message,
    Ctx = any,
> implements EventHandler<E, Ctx> {
    protected static selectors: Selector[];

    public static registerSelector(selector: Selector): void {
        if (this === SelectorBasedEventHandler) {
            throw new Error(
                "cannot register selector to SelectorBasedEventHandler"
            );
        }

        if (!this.selectors) {
            this.selectors = [];
        }

        this.selectors.push(selector);
    }

    public static canHandleStatic(event: Message): boolean {
        if (!this.selectors) {
            return false;
        }

        return this.selectors.some(({ predicate }) => predicate(event));
    }

    public canHandle(message: Message): boolean {
        return (
            this.constructor as typeof SelectorBasedEventHandler
        ).canHandleStatic(message);
    }

    protected getSelectors(): Selector[] {
        return (this.constructor as any).selectors || [];
    }

    protected selectHandlingMethod(event: E): keyof this | null {
        const methods = this.getSelectors().filter(({ predicate }) =>
            predicate(event)
        );

        if (methods.length > 1) {
            throw new Error(
                `Multiple handling routines selected for event '${event.getMessageType()}'`
            );
        }

        if (methods.length === 0) {
            return null;
        }

        return methods[0].method as keyof this;
    }

    public async handle(event: E, ctx: Ctx): Promise<void> {
        const handlingMethod = this.selectHandlingMethod(event);

        if (handlingMethod === null) {
            return;
        }

        await this.doHandle(handlingMethod, event, ctx);
    }

    protected async doHandle(
        method: keyof this,
        event: E,
        ctx: Ctx
    ): Promise<void> {
        const handler = this[method] as (event: E, ctx: Ctx) => Promise<void>;
        await handler.call(this, event, ctx);
    }
}
