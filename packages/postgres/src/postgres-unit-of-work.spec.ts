import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import * as pg from "pg";
import _ from "lodash";

import { Propagation } from "@hexaijs/core";
import { IsolationLevel } from "./types";
import { PostgresUnitOfWork } from "./postgres-unit-of-work";
import {
    newClient,
    useClient,
    useDatabase,
    useTableManager,
} from "@/test-fixtures";

const DATABASE = "test_hexai__uow";
const TABLE = "_test";

async function getTransactionId(client: pg.Client): Promise<string> {
    const result = await client.query(`SELECT txid_current();`);
    return result.rows[0].txid_current;
}

function areSameTransaction(...txids: string[]): boolean {
    return new Set(txids).size === 1;
}

function areDistinctTransactions(...txids: string[]): boolean {
    return new Set(txids).size === txids.length;
}

describe("PostgresUnitOfWork", () => {
    // requires admin privileges to create/drop databases
    useDatabase(DATABASE);
    const tableManager = useTableManager(DATABASE);
    const conn = useClient(DATABASE);
    const uow = new PostgresUnitOfWork(
        () => newClient(DATABASE),
        (c) => c.end()
    );

    let verificationRepo: {
        exists: (id: number) => Promise<boolean>;
        count: () => Promise<number>;
    };

    beforeAll(async () => {
        await tableManager.createTable(TABLE, [
            { name: "id", property: "INT" },
        ]);

        verificationRepo = {
            async exists(id: number): Promise<boolean> {
                const result = await conn.query(
                    `SELECT COUNT(*) FROM ${TABLE} WHERE id = $1;`,
                    [id]
                );
                return result.rows[0].count > 0;
            },
            async count(): Promise<number> {
                const result = await conn.query(
                    `SELECT COUNT(*) FROM ${TABLE};`
                );
                return parseInt(result.rows[0].count);
            },
        };
    });

    beforeEach(async () => {
        await tableManager.truncateTable(TABLE);
    });

    async function insertRecord(client: pg.Client, id: number): Promise<void> {
        await client.query(`INSERT INTO ${TABLE} VALUES ($1);`, [id]);
    }

    async function expectRecordExists(id: number): Promise<void> {
        expect(await verificationRepo.exists(id)).toBe(true);
    }

    async function expectRecordNotExists(id: number): Promise<void> {
        expect(await verificationRepo.exists(id)).toBe(false);
    }

    async function expectRecordCount(count: number): Promise<void> {
        expect(await verificationRepo.count()).toBe(count);
    }

    async function runFailingTransaction(
        fn: (client: pg.Client) => Promise<void>
    ): Promise<void> {
        try {
            await uow.wrap(async (client) => {
                await fn(client);
                throw new Error("transaction failure");
            });
        } catch {
            // expected
        }
    }

    async function runFailingSavepoint(
        fn: (client: pg.Client) => Promise<void>
    ): Promise<void> {
        try {
            await uow.wrap(
                async (client) => {
                    await fn(client);
                    throw new Error("savepoint failure");
                },
                { propagation: Propagation.NESTED }
            );
        } catch {
            // expected
        }
    }

    async function runSavepoint(
        fn: (client: pg.Client) => Promise<void>
    ): Promise<void> {
        await uow.wrap(fn, { propagation: Propagation.NESTED });
    }

    async function runNestedTransaction(
        fn: (client: pg.Client) => Promise<void>
    ): Promise<void> {
        await uow.wrap(fn, { propagation: Propagation.EXISTING });
    }

    async function runFailingNestedTransaction(
        fn: (client: pg.Client) => Promise<void>
    ): Promise<void> {
        try {
            await uow.wrap(
                async (client) => {
                    await fn(client);
                    throw new Error("nested failure");
                },
                { propagation: Propagation.EXISTING }
            );
        } catch {
            // expected
        }
    }

    describe("transaction lifecycle", () => {
        test("throws when accessing client outside transaction boundary", async () => {
            expect(() => uow.getClient()).toThrowError(/.*not started.*/);
        });

        test("provides consistent client reference within transaction", async () => {
            const txids: string[] = [];

            await uow.wrap(async (client) => {
                txids.push(await getTransactionId(client));
                txids.push(await getTransactionId(uow.getClient()));
            });

            expect(areSameTransaction(...txids)).toBe(true);
        });

        test("commits all changes on successful completion", async () => {
            await uow.wrap(async (client) => {
                await insertRecord(client, 1);
            });

            await expectRecordExists(1);
        });

        test("rolls back all changes when error occurs", async () => {
            await runFailingTransaction(async (client) => {
                await insertRecord(client, 1);
            });

            await expectRecordNotExists(1);
        });

        test("creates isolated transaction for each wrap call", async () => {
            const txids: string[] = [];

            await Promise.all(
                _.times(5, async () => {
                    await uow.wrap(async (client) => {
                        txids.push(await getTransactionId(client));
                    });
                })
            );

            expect(areDistinctTransactions(...txids)).toBe(true);
        });

        test("releases database connection after transaction ends", async () => {
            let capturedClient!: pg.Client;

            await uow.wrap(async () => {
                capturedClient = uow.getClient();
            });

            await expect(getTransactionId(capturedClient)).rejects.toThrowError(
                /.*closed.*/
            );
        });
    });

    describe("joining existing transaction", () => {
        test("shares transaction context with parent", async () => {
            const txids: string[] = [];

            await uow.wrap(async (client) => {
                txids.push(await getTransactionId(client));

                await runNestedTransaction(async (nested) => {
                    txids.push(await getTransactionId(nested));
                });
            });

            expect(areSameTransaction(...txids)).toBe(true);
        });

        test("starts new transaction when no parent exists", async () => {
            const txids: string[] = [];

            await uow.wrap(
                async (client) => {
                    txids.push(await getTransactionId(client));
                    txids.push(await getTransactionId(client));
                },
                { propagation: Propagation.EXISTING }
            );

            expect(areSameTransaction(...txids)).toBe(true);
        });

        test("rolls back entire transaction when nested operation fails", async () => {
            await uow.wrap(async (client) => {
                await insertRecord(client, 1);

                await runFailingNestedTransaction(async () => {});
            });

            await expectRecordCount(0);
        });

        test("commits all changes when nested operations succeed", async () => {
            await uow.wrap(async (client) => {
                await insertRecord(client, 1);

                await runNestedTransaction(async (nested) => {
                    await insertRecord(nested, 2);
                });
            });

            await expectRecordCount(2);
        });
    });

    describe("creating new transaction", () => {
        test("creates independent transaction for each NEW propagation", async () => {
            const txids: string[] = [];

            await uow.wrap(async () => {
                await Promise.all(
                    _.times(5, async () => {
                        await uow.wrap(
                            async (client) => {
                                txids.push(await getTransactionId(client));
                            },
                            { propagation: Propagation.NEW }
                        );
                    })
                );
            });

            expect(areDistinctTransactions(...txids)).toBe(true);
        });
    });

    describe("nested savepoints", () => {
        test("starts new transaction when no parent exists", async () => {
            const txids: string[] = [];

            await uow.wrap(
                async (client) => {
                    txids.push(await getTransactionId(client));
                    txids.push(await getTransactionId(client));
                },
                { propagation: Propagation.NESTED }
            );

            expect(areSameTransaction(...txids)).toBe(true);
        });

        test("rolls back only savepoint changes while preserving parent transaction", async () => {
            await uow.wrap(async (root) => {
                await insertRecord(root, 1);

                await runFailingSavepoint(async (savepoint) => {
                    await insertRecord(savepoint, 2);
                });

                await insertRecord(root, 3);

                await runSavepoint(async (savepoint) => {
                    await insertRecord(savepoint, 4);
                });
            });

            await expectRecordExists(1);
            await expectRecordNotExists(2);
            await expectRecordExists(3);
            await expectRecordExists(4);
        });

        test("rolls back to savepoint when nested operation fails inside savepoint", async () => {
            await uow.wrap(async (root) => {
                await insertRecord(root, 1);

                await uow.wrap(
                    async (savepoint) => {
                        await insertRecord(savepoint, 2);

                        await runFailingNestedTransaction(async () => {});
                    },
                    { propagation: Propagation.NESTED }
                );
            });

            await expectRecordCount(1);
            await expectRecordExists(1);
        });
    });

    describe("transaction isolation", () => {
        test.each([
            IsolationLevel.READ_COMMITTED,
            IsolationLevel.REPEATABLE_READ,
            IsolationLevel.SERIALIZABLE,
        ])("applies %s isolation level", async (isolationLevel) => {
            await uow.wrap(
                async (client) => {
                    const result = await client.query(
                        "SHOW TRANSACTION ISOLATION LEVEL"
                    );

                    expect(result.rows[0].transaction_isolation).toBe(
                        isolationLevel
                    );
                },
                { isolationLevel }
            );
        });
    });

    describe("query method", () => {
        test("executes query without transaction", async () => {
            await uow.query(async (client) => {
                await insertRecord(client, 1);
            });

            await expectRecordExists(1);
        });

        test("reuses client when inside wrap()", async () => {
            const txids: string[] = [];

            await uow.wrap(async (wrapClient) => {
                txids.push(await getTransactionId(wrapClient));

                await uow.query(async (queryClient) => {
                    txids.push(await getTransactionId(queryClient));
                });
            });

            expect(areSameTransaction(...txids)).toBe(true);
        });

        test("uses separate connections when outside transaction", async () => {
            const txids: string[] = [];

            await uow.query(async (client) => {
                txids.push(await getTransactionId(client));
            });
            await uow.query(async (client) => {
                txids.push(await getTransactionId(client));
            });

            expect(areDistinctTransactions(...txids)).toBe(true);
        });

        test("cleans up client on error", async () => {
            await expect(
                uow.query(async () => {
                    throw new Error("query error");
                })
            ).rejects.toThrow("query error");
        });

        test("changes are visible immediately without transaction", async () => {
            await uow.query(async (client) => {
                await insertRecord(client, 1);
            });

            await uow.query(async (client) => {
                const result = await client.query(
                    `SELECT COUNT(*) FROM ${TABLE} WHERE id = 1;`
                );
                expect(parseInt(result.rows[0].count)).toBe(1);
            });
        });
    });
});
