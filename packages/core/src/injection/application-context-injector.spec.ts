import { beforeEach, describe, expect, test, vi } from "vitest";
import { ApplicationContextInjector } from "./application-context-injector";

describe("ApplicationContextInjector", () => {
    let injector: ApplicationContextInjector;
    const dummyApplicationContext = {};

    beforeEach(() => {
        injector = new ApplicationContextInjector();
        injector.setInjectingObject(dummyApplicationContext);
    });

    test.each([1, "a", {}, [], undefined, null])(
        "does nothing when target is not ApplicationContextAware",
        (invalidTarget) => {
            injector.addCandidate(invalidTarget);

            expect(() => injector.inject()).not.toThrowError();
        }
    );

    test("injects", () => {
        const target = {
            setApplicationContext: vi.fn(),
        };
        injector.addCandidate(target);

        injector.inject();

        expect(target.setApplicationContext).toHaveBeenCalledWith(
            dummyApplicationContext
        );
    });
});
