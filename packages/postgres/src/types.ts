import * as pg from "pg";

import { BaseUnitOfWorkOptions, IsolationLevel } from "@hexai/core/infra";

export type ClientFactory = () => pg.Client | Promise<pg.Client>;

export type ClientCleanUp = (client: pg.Client) => void | Promise<void>;

export interface PostgresTransactionOptions extends BaseUnitOfWorkOptions {
    isolationLevel?: IsolationLevel;
}
