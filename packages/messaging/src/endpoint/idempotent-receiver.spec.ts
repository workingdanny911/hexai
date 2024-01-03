import { describe, expect, it, test } from "vitest";

import { ApplicationContextAware } from "@hexai/core/injection";
import { BaseApplicationContext } from "@hexai/core/application";

class IdempotentReceiver<C extends BaseApplicationContext>
    implements ApplicationContextAware<C>
{
    private applicationContext!: C;

    setApplicationContext(context: C): void {
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
