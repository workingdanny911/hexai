import { UnitOfWork } from "@/infra";

import type { TestAPI } from "vitest";

export function makeTransactionalTest(
    base: any,
    uowFactory: () => Promise<UnitOfWork>,
    annihilate?: (uow: UnitOfWork) => Promise<void>
): TestAPI {
    return base.extend({
        transactional: [
            // eslint-disable-next-line no-empty-pattern
            async ({}, runTest: any) => {
                const uow = await uowFactory();

                await uow.wrap(() => runTest(null));

                annihilate && (await annihilate(uow));
            },
            { auto: true },
        ],
    });
}
