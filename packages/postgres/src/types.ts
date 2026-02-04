import * as pg from "pg";

import { BaseUnitOfWorkOptions } from "@hexaijs/core";

export type ClientFactory = () => pg.ClientBase | Promise<pg.ClientBase>;

export type ClientCleanUp = (client: pg.ClientBase) => void | Promise<void>;

export enum IsolationLevel {
    READ_UNCOMMITTED = "read uncommitted",
    READ_COMMITTED = "read committed",
    REPEATABLE_READ = "repeatable read",
    SERIALIZABLE = "serializable",
}

export interface PostgresTransactionOptions extends BaseUnitOfWorkOptions {
    isolationLevel?: IsolationLevel;
}
