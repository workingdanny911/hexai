import { AsyncLocalStorage } from "node:async_hooks";

import { beforeEach, describe, expect, test, vi } from "vitest";

import { CommonUnitOfWorkOptions, UnitOfWork } from "@/infra";
import { ApplicationContextAware } from "@/application";
import { Atomic } from "./atomic";

class UnitOfWorkForTest implements UnitOfWork<null> {
    als = new AsyncLocalStorage();
    private store!: any;

    public setStore(store: any): void {
        this.store = store;
    }

    async wrap<T>(
        fn: (client: null) => Promise<T>,
        options?: Partial<CommonUnitOfWorkOptions>
    ): Promise<T> {
        return this.als.run(this.store, () => fn(null));
    }

    getClient() {
        return null;
    }
}

interface UoWHolder {
    getUnitOfWork(): UnitOfWorkForTest;
}

describe("atomic", () => {
    const unitOfWork = new UnitOfWorkForTest();
    const applicationContext = {
        getUnitOfWork: () => unitOfWork,
    };

    beforeEach(() => {
        vi.resetAllMocks();
    });

    test("when target is not aware of application context", async () => {
        expect(() => {
            class InvalidTarget {
                // @ts-expect-error
                @Atomic()
                async someMethod(): Promise<void> {}
            }
        }).toThrow("does not implement 'ApplicationContextAware'");
    });

    test("when application context is not injected", async () => {
        class Target implements ApplicationContextAware<UoWHolder> {
            @Atomic()
            async transactionalMethod(): Promise<void> {}

            setApplicationContext(applicationContext: UoWHolder): void {}
        }

        await expect(new Target().transactionalMethod()).rejects.toThrowError(
            "application context not injected"
        );
    });

    test("wraps method with unit of work", async () => {
        let storeInTrasactionalMethod!: any;

        class Target implements ApplicationContextAware<UoWHolder> {
            @Atomic()
            async transactionalMethod(): Promise<void> {
                storeInTrasactionalMethod = unitOfWork.als.getStore();
            }

            setApplicationContext(applicationContext: UoWHolder): void {}
        }

        const target = new Target();
        target.setApplicationContext(applicationContext);
        unitOfWork.setStore("store");

        await target.transactionalMethod();

        expect(storeInTrasactionalMethod).toBe("store");
    });
});
