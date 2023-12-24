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

describe("prisma unit of work", () => {
    const prisma = new PrismaClient();
    let txids: Set<string>;

    beforeAll(async () => {
        await prisma.$queryRaw`DROP TABLE IF EXISTS _test;`;
        await prisma.$queryRaw`CREATE TABLE _test (id INT);`;
    });

    beforeEach(() => {
        prismaUnitOfWork.setClient(prisma);
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
        prismaUnitOfWork.setClient(undefined as any);

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

    test("forcing new uow", async () => {
        await prismaUnitOfWork.wrap(async () => {
            await addCurrentTxid();

            await prismaUnitOfWork.wrapWithNew(addCurrentTxid);
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

    test("when options vary between nested uows", async () => {
        await prismaUnitOfWork.wrap(
            async () => {
                await expect(
                    prismaUnitOfWork.wrap(async () => {}, {
                        isolationLevel:
                            Prisma.TransactionIsolationLevel.Serializable,
                    })
                ).rejects.toThrowError(
                    "options cannot vary between nested uows"
                );
            },
            {
                isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            }
        );
    });

    test("options", async () => {
        const spy = vi.spyOn(prisma, "$transaction");
        const fn = async () => {};
        const options = {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 1000,
            timeout: 1000,
        };

        // serializable
        await prismaUnitOfWork.wrap(fn, options);

        expect(spy).toHaveBeenCalledWith(expect.anything(), options);
    });
});
