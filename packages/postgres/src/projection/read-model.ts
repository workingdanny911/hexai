import type { ClientBase } from "pg";

import type { StoredEvent } from "@hexaijs/core";

export interface IPostgresReadModel {
    readonly name: string;
    readonly version: number;
    canHandle(storedEvent: StoredEvent): boolean;
    /**
     * Apply a stored event to the read model using the provided transactional
     * client. The engine commits the read model write and the projection
     * checkpoint in the same transaction, so a crash before commit replays the
     * event rather than skipping it.
     *
     * Implementations should be idempotent. Delivery is at-least-once: a commit
     * that succeeds server-side but reports a client error (commit ambiguity),
     * or a retry after a transient failure, can re-apply the same event. Prefer
     * upserts / `ON CONFLICT` over blind inserts.
     */
    apply(storedEvent: StoredEvent, client: ClientBase): Promise<void>;
    reset(client: ClientBase): Promise<void>;
}
