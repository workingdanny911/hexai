import * as pg from "pg";

import { BaseUnitOfWorkOptions } from "@hexaijs/core";

export type ClientFactory = () => pg.Client | Promise<pg.Client>;

export type ClientCleanUp = (client: pg.Client) => void | Promise<void>;

export enum IsolationLevel {
    READ_UNCOMMITTED = "read uncommitted",
    READ_COMMITTED = "read committed",
    REPEATABLE_READ = "repeatable read",
    SERIALIZABLE = "serializable",
}

export interface PostgresTransactionOptions extends BaseUnitOfWorkOptions {
    isolationLevel?: IsolationLevel;
}
