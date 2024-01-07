import * as pg from "pg";

import { CommonUnitOfWorkOptions, IsolationLevel } from "@hexai/core";

export type ClientFactory = () => pg.Client | Promise<pg.Client>;

export type ClientCleanUp = (client: pg.Client) => void | Promise<void>;

export interface PostgresTransactionOptions extends CommonUnitOfWorkOptions {
    isolationLevel?: IsolationLevel;
}
