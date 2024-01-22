import { beforeEach, describe, expect, it, test, vi } from "vitest";
import _ from "lodash";

import { AbstractInjector } from "./abstract-injector";

interface FooAware {
    setFoo(foo: string): void;
}

class FooInjector extends AbstractInjector<string, FooAware> {
    protected isInjectable(candidate: unknown): candidate is FooAware {
        return _.isObject(candidate) && "setFoo" in candidate;
    }

    protected doInject(target: FooAware, foo: string): void {
        target.setFoo(foo);
    }
}

describe("Injector", () => {
    let injector: FooInjector;
    const target = {
        setFoo: vi.fn(),
    };

    beforeEach(() => {
        injector = new FooInjector();
        injector.setInjectingObject("foo");
        vi.resetAllMocks();
    });

    test("when injecting object is not set", () => {
        const injector = new FooInjector();

        // does not throw when no targets are selected
        injector.addCandidate(null);
        expect(() => injector.inject()).not.toThrowError();

        injector.addCandidate(target);
        expect(() => injector.inject()).toThrowError(
            /.*Injecting object is not set.*/
        );
    });

    test("when no candidates", () => {
        injector.setInjectingObject("foo");

        // no-op
        expect(() => injector.inject()).not.toThrowError();
    });

    test.each([1, "a", {}, [], undefined, null, { setBar: vi.fn() }])(
        "when target object is not injectable",
        (target) => {
            const orig = _.cloneDeep(target);

            injector.addCandidate(target);
            injector.inject();

            expect(target).toEqual(orig);
        }
    );

    test("isInjectingObjectSet", () => {
        const injector = new FooInjector();
        expect(injector.isInjectingObjectSet()).toBe(false);
        injector.setInjectingObject("foo");
        expect(injector.isInjectingObjectSet()).toBe(true);
    });

    it("injects", () => {
        injector.setInjectingObject("foo");
        injector.addCandidate(target);

        injector.inject();

        expect(target.setFoo).toHaveBeenCalledWith("foo");
    });
});
