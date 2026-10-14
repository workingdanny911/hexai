import type * as pg from "pg";

/**
 * Something that runs a SQL query. The unit of work's `db` is one, and pg's
 * `Client`, `PoolClient` and `Pool` fit this type as they are, so code that
 * only queries can accept any of them.
 */
export interface PostgresQueryable {
    query<R extends pg.QueryResultRow = any>(
        text: string,
        values?: readonly unknown[]
    ): Promise<pg.QueryResult<R>>;
}

// pg sends a query with values through the extended protocol, which takes one
// statement. queryMode forces that protocol for a query without values too
// (pg 8.12+), so a call can never carry a second statement. @types/pg does not
// declare the option yet.
type SingleStatementQueryConfig = pg.QueryConfig & { queryMode: "extended" };

// Copies the values when the query is called, so changing the array afterwards
// cannot change a query that is still waiting for its turn.
export function singleStatementQuery(
    text: string,
    values: readonly unknown[] | undefined
): SingleStatementQueryConfig {
    return {
        text,
        values: values === undefined ? undefined : [...values],
        queryMode: "extended",
    };
}
