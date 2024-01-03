import { beforeEach, describe, expect, test, vi } from "vitest";

import { BaseApplicationContext } from "@/application";
import { ApplicationContextAware } from "@/injection/application-context-aware";
import { ApplicationContextInjector } from "@/injection/application-context-injector";

describe("ApplicationContextInjector", () => {
    let injector: ApplicationContextInjector<BaseApplicationContext>;
    const dummyApplicationContext: BaseApplicationContext = {
        getUnitOfWork: vi.fn(),
        getOutboxEventPublisher: vi.fn(),
    };

    beforeEach(() => {
        injector = new ApplicationContextInjector();
        injector.setInjectingObject(dummyApplicationContext);

        vi.resetAllMocks();
    });

    test("when injecting object is not set", () => {
        injector = new ApplicationContextInjector();

        // @ts-expect-error
        expect(() => injector.injectTo({})).toThrowError(
            /.*Injecting object is not set.*/
        );
    });

    test.each([1, "a", {}, [], undefined, null, () => {}])(
        "when target object is not an ApplicationContextAware",
        (target) => {
            expect(injector.canInjectTo(target)).toBe(false);
            // @ts-expect-error
            expect(() => injector.injectTo(target)).toThrowError(
                /.*is not an 'ApplicationContextAware'.*/
            );
        }
    );

    test("injects the application context", () => {
        const target: ApplicationContextAware<BaseApplicationContext> = {
            setApplicationContext: vi.fn(),
        };

        injector.injectTo(target);

        expect(target.setApplicationContext).toHaveBeenCalledWith(
            dummyApplicationContext
        );
    });
});
