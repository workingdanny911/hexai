import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    test,
    vi,
} from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";

import { prismaUnitOfWork } from "./prisma-unit-of-work";
import { IsolationLevel, Propagation } from "Hexai/infra";

describe("prisma unit of work", () => {
    const prisma = new PrismaClient();
    let txids: Set<string>;

    beforeAll(async () => {
        await prisma.$queryRaw`DROP TABLE IF EXISTS _test;`;
        await prisma.$queryRaw`CREATE TABLE _test (id INT);`;
    });

    beforeEach(() => {
        prismaUnitOfWork.bindClient(prisma);
        txids = new Set<string>();
    });

    afterAll(async () => {
        await prisma.$queryRaw`DROP TABLE IF EXISTS _test;`;
    });

    async function addCurrentTxid(): Promise<void> {
        const result: Array<{ txid: string }> =
            await prismaUnitOfWork.getClient()
                .$queryRaw`SELECT txid_current() as txid;`;

        txids.add(result[0].txid);
    }

    function getNumberOfDistinctTxids(): number {
        return txids.size;
    }

    test("cannot get client outside of uow", async () => {
        expect(() => prismaUnitOfWork.getClient()).toThrowError(
            /.*not started.*/
        );
    });

    test("client returned from getClient() and inside uow are the same", async () => {
        await prismaUnitOfWork.wrap(async (client) => {
            expect(client).toBe(prismaUnitOfWork.getClient());
        });
    });

    test("cannot start if prisma client is not set", async () => {
        prismaUnitOfWork.bindClient(undefined as any);

        expect(prismaUnitOfWork.wrap(async () => {})).rejects.toThrowError(
            /.*client is not set.*/
        );
    });

    test("sequential execution in the same uow", async () => {
        await prismaUnitOfWork.wrap(async () => {
            await addCurrentTxid();
            await addCurrentTxid();
            await addCurrentTxid();
        });

        expect(getNumberOfDistinctTxids()).toBe(1);
    });

    test("parallel execution in the same uow", async () => {
        await prismaUnitOfWork.wrap(async () => {
            const promises = Array.from({ length: 3 }, () => addCurrentTxid());

            await Promise.all(promises);
        });

        expect(getNumberOfDistinctTxids()).toBe(1);
    });

    test("with nested uows", async () => {
        await prismaUnitOfWork.wrap(async () => {
            await addCurrentTxid();

            await prismaUnitOfWork.wrap(async () => {
                await addCurrentTxid();
            });
        });

        expect(getNumberOfDistinctTxids()).toBe(1);
    });

    test("with nested uows and parallel execution", async () => {
        await prismaUnitOfWork.wrap(async () => {
            await addCurrentTxid();

            await Promise.all([
                prismaUnitOfWork.wrap(addCurrentTxid),
                prismaUnitOfWork.wrap(addCurrentTxid),
            ]);

            await addCurrentTxid();
        });

        expect(getNumberOfDistinctTxids()).toBe(1);
    });

    test("forcing new transaction", async () => {
        await prismaUnitOfWork.wrap(async () => {
            await addCurrentTxid();

            await prismaUnitOfWork.wrap(addCurrentTxid, {
                propagation: Propagation.NEW,
            });
        });

        expect(getNumberOfDistinctTxids()).toBe(2);
    });

    test("auto rollback on error", async () => {
        async function invalidOperation() {
            await prismaUnitOfWork.wrap(async (client) => {
                await client.$queryRaw`INSERT INTO _test VALUES (1);`;

                throw new Error("should rollback");
            });
        }

        expect(invalidOperation()).rejects.toThrowError();

        expect(await prisma.$queryRaw`SELECT * FROM _test;`).toEqual([]);
    });

    test.each([
        {
            isolationLevel: IsolationLevel.SERIALIZABLE,
            expectedIsolationLevel:
                Prisma.TransactionIsolationLevel.Serializable,
        },
        {
            isolationLevel: IsolationLevel.REPEATABLE_READ,
            expectedIsolationLevel:
                Prisma.TransactionIsolationLevel.RepeatableRead,
        },
        {
            isolationLevel: IsolationLevel.READ_COMMITTED,
            expectedIsolationLevel:
                Prisma.TransactionIsolationLevel.ReadCommitted,
        },
        {
            isolationLevel: IsolationLevel.READ_UNCOMMITTED,
            expectedIsolationLevel:
                Prisma.TransactionIsolationLevel.ReadUncommitted,
        },
    ])("options", async ({ isolationLevel, expectedIsolationLevel }) => {
        const spy = vi.spyOn(prisma, "$transaction");
        const fn = async () => {};
        const options = {
            isolationLevel,
            maxWait: 1000,
            timeout: 1000,
        };

        // serializable
        await prismaUnitOfWork.wrap(fn, options);

        expect(spy).toHaveBeenCalledWith(expect.anything(), {
            isolationLevel: expectedIsolationLevel,
            maxWait: 1000,
            timeout: 1000,
        });
    });
});
