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
     * Processing is effectively-once: within that same transaction the engine
     * locks and reads the committed checkpoint (`SELECT ... FOR UPDATE`) and
     * skips any event whose position is already covered, so an in-process retry
     * after a commit-ambiguous failure cannot re-apply an already-committed
     * event.
     *
     * Even so, implementations should stay idempotent as defense-in-depth —
     * prefer upserts / `ON CONFLICT` over blind inserts. The guard relies on the
     * mutation and checkpoint sharing one transaction; an implementation that
     * writes outside that transaction forfeits the guarantee.
     */
    apply(storedEvent: StoredEvent, client: ClientBase): Promise<void>;
    reset(client: ClientBase): Promise<void>;
}
