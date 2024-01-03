import { describe, expect, it, test } from "vitest";

import { ApplicationContextAware } from "@hexai/core/injection";
import { BaseApplicationContext } from "@hexai/core/application";
import { UnitOfWork } from "@hexai/core/infra";
import { IdempotencySupport } from "@/types";

class IdempotentReceiver<
    U extends UnitOfWork<any, any>,
    C extends BaseApplicationContext<U>,
> implements ApplicationContextAware<C>
{
    protected applicationContext!: C;

    constructor(
        protected key: string,
        protected handler: (message: any) => Promise<void>,
        protected support: IdempotencySupport
    ) {}

    public setApplicationContext(context: C): void {
        this.applicationContext = context;
    }
}

describe("IdempotentReceiver", () => {
    test("test", () => {
        expect(1).toBe(1);
    });

    it("test", () => {
        expect(1).toBe(1);
    });
});
