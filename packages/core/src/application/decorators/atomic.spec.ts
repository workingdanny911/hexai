import { beforeEach, describe, expect, test } from "vitest";

import { UnitOfWork } from "@/infra";
import { Counter, CounterApplicationContext, CounterId } from "@/test";
import { Atomic } from "./atomic";

describe("atomic", () => {
    const applicationContext = new CounterApplicationContext();
    const counterRepo = applicationContext.getCounterRepository();
    const unitOfWork = applicationContext.getUnitOfWork();

    beforeEach(() => {
        CounterApplicationContext.clear();
    });

    test("when target instance has no unit of work", async () => {
        class Target {
            @Atomic()
            async do(): Promise<void> {}
        }

        await expect(new Target().do()).rejects.toThrowError(
            "UnitOfWorkHolder not implemented"
        );
    });

    test("when target instance has unit of work", async () => {
        class Target {
            getUnitOfWork(): UnitOfWork {
                return unitOfWork;
            }

            @Atomic()
            async do(): Promise<void> {
                await counterRepo.add(
                    Counter.create(CounterId.from("counter-id"))
                );

                throw new Error("rollback");
            }
        }

        await expect(new Target().do()).rejects.toThrow("rollback");
        expect(await counterRepo.count()).toBe(0);
    });

    test("when nested", async () => {
        class A {
            getUnitOfWork(): UnitOfWork {
                return unitOfWork;
            }

            @Atomic()
            async do(): Promise<void> {
                throw new Error("rollback");
            }
        }

        class B {
            getUnitOfWork(): UnitOfWork {
                return unitOfWork;
            }

            @Atomic()
            async do(): Promise<void> {
                try {
                    await new A().do();
                } catch {}

                await counterRepo.add(
                    Counter.create(CounterId.from("counter-id"))
                );
            }
        }

        await expect(new B().do()).rejects.toThrow("closed");

        expect(await counterRepo.count()).toBe(0);
    });
});
