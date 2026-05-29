import type { ClientBase } from "pg";

import type { IPostgresReadModel } from "./read-model.js";
import type { Selector } from "./selector.js";
import type { StoredEvent } from "@hexaijs/core";

export abstract class SelectorBasedReadModel implements IPostgresReadModel {
    abstract readonly name: string;
    abstract readonly version: number;

    protected static selectors: Selector[];

    public static registerSelector(selector: Selector): void {
        if (this === SelectorBasedReadModel) {
            throw new Error(
                "cannot register selector to SelectorBasedReadModel"
            );
        }

        if (!Object.hasOwn(this, "selectors")) {
            this.selectors = [];
        }

        this.selectors.push(selector);
    }

    canHandle(storedEvent: StoredEvent): boolean {
        const ctor = this.constructor as typeof SelectorBasedReadModel;

        if (!ctor.selectors) {
            return false;
        }

        return ctor.selectors.some(({ predicate }) => predicate(storedEvent));
    }

    async apply(storedEvent: StoredEvent, client: ClientBase): Promise<void> {
        const method = this.selectHandlingMethod(storedEvent);

        if (method === null) {
            return;
        }

        const handler = this[method] as (
            storedEvent: StoredEvent,
            client: ClientBase
        ) => Promise<void>;
        await handler.call(this, storedEvent, client);
    }

    abstract reset(client: ClientBase): Promise<void>;

    private selectHandlingMethod(storedEvent: StoredEvent): keyof this | null {
        const ctor = this.constructor as typeof SelectorBasedReadModel;
        const matched = (ctor.selectors ?? []).filter(({ predicate }) =>
            predicate(storedEvent)
        );

        if (matched.length > 1) {
            throw new Error(
                `Multiple handling methods selected for event '${storedEvent.event.getMessageType()}'`
            );
        }

        if (matched.length === 0) {
            return null;
        }

        return matched[0].method as keyof this;
    }
}
