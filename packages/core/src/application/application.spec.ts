import {
    beforeEach,
    describe,
    expect,
    expectTypeOf,
    it,
    test,
    vi,
} from "vitest";

import {
    Application,
    ApplicationExtension,
    NoHandlerFound,
} from "./application";
import { Handler } from "./handler";
import { SimpleHandlerRegistry } from "./fixtures";

class ApplicationForTest extends Application {
    constructor(ctx?: any) {
        super(ctx ?? {}, new SimpleHandlerRegistry());
    }
}

describe("Application", () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    function newApp(ctx?: any) {
        return new ApplicationForTest();
    }

    function handlerMock() {
        return {
            handle: vi.fn(),
            throwing(this: any, error: Error) {
                this.handle.mockRejectedValue(error);
                return this;
            },
            setApplicationContext: vi.fn(),
            shouldHaveBeenInjectedWith(this: any, ctx: any) {
                expect(this.setApplicationContext).toHaveBeenCalledWith(ctx);
            },
            shouldHaveHandled(this: any, request: any) {
                expect(this.handle).toHaveBeenCalledWith(request);
            },
            shouldNotHaveHandledAny(this: any) {
                expect(this.handle).not.toHaveBeenCalled();
            },
        };
    }

    it("delegates to request handler", async () => {
        const handler = handlerMock();
        const app = newApp().withHandler("foo", handler);
        const request = {
            type: "foo",
            payload: "bar",
        };
        await app.start();

        await app.handle(request);

        handler.shouldHaveHandled(request);
    });

    it("finds handler for request using request handler registry", async () => {
        const fooHandler = handlerMock();
        const barHandler = handlerMock();
        const app = newApp()
            .withHandler("foo", fooHandler)
            .withHandler("bar", barHandler);
        await app.start();

        await app.handle({
            type: "bar",
        });

        fooHandler.shouldNotHaveHandledAny();
        barHandler.shouldHaveHandled({
            type: "bar",
        });
    });

    it("throws NoHandlerMatchedError when no handler is found", async () => {
        const app = newApp();
        await app.start();

        const handle = () => app.handle({ type: "foo" });

        await expect(handle).rejects.toThrowError(NoHandlerFound);
    });

    it("injects context to application context aware request handlers, upon start", async () => {
        const handler = handlerMock();
        const ctx = {};
        const app = newApp(ctx).withHandler("foo", handler);

        await app.start();

        handler.shouldHaveBeenInjectedWith(ctx);
    });

    function companionMock() {
        let isRunning = false;

        return {
            start: vi.fn().mockImplementation(() => {
                isRunning = true;
            }),
            stop: vi.fn().mockImplementation(() => {
                isRunning = false;
            }),
            shouldBeRunning() {
                expect(isRunning).toBe(true);
            },
            shouldNotBeRunning() {
                expect(isRunning).toBe(false);
            },
        };
    }

    test("starting and stopping application", async () => {
        const app = newApp();
        expect(app.isRunning()).toBe(false);

        await app.start();
        expect(app.isRunning()).toBe(true);

        await app.stop();
        expect(app.isRunning()).toBe(false);
    });

    it("rejects to handle requests when application is not running", async () => {
        const app = newApp().withHandler(
            "dummy",
            (msg: { type: "dummy" }) => {}
        );

        const handle = () =>
            app.handle({
                type: "dummy",
            });
        await expect(handle()).rejects.toThrowError(
            /application is not running/
        );

        await app.start();
        await expect(handle()).resolves.not.toThrow();

        await app.stop();
        await expect(handle()).rejects.toThrowError(
            /application is not running/
        );
    });

    it("starts and stops registered lifecycle components upon start and stop", async () => {
        const companion1 = companionMock();
        const companion2 = companionMock();
        const app = newApp()
            .registerCompanion("companion1", companion1)
            .registerCompanion("companion2", companion2);

        await app.start();
        companion1.shouldBeRunning();
        companion2.shouldBeRunning();

        await app.stop();
        companion1.shouldNotBeRunning();
        companion2.shouldNotBeRunning();
    });

    it.each(["companion", Symbol.for("companion")])(
        "replaces existing companion with the same name",
        async (name) => {
            const companion1 = companionMock();
            const companion2 = companionMock();
            const app = newApp()
                .registerCompanion(name, companion1)
                .registerCompanion(name, companion2);

            await app.start();

            companion1.shouldNotBeRunning();
            companion2.shouldBeRunning();
        }
    );

    describe("events", () => {
        test("notifies when application starts", async () => {
            const app = newApp();
            const onStart = vi.fn();
            app.on("started", onStart);

            await app.start();

            expect(onStart).toHaveBeenCalled();
        });

        test("notifies when application stops", async () => {
            const app = newApp();
            const onStop = vi.fn();
            app.on("stopped", onStop);

            await app.start();
            await app.stop();

            expect(onStop).toHaveBeenCalled();
        });
    });

    describe("typing", () => {
        test("should be able to infer result type by request type", async () => {
            const fooHandler: Handler<{ type: "foo" }, "fooReturn"> = () =>
                "fooReturn";
            const barHandler: Handler<{ type: "bar" }, "barReturn"> = () =>
                "barReturn";

            const app = newApp()
                .withHandler("foo", fooHandler)
                .withHandler("bar", barHandler);
            await app.start();

            const fooRequest = { type: "foo" } as const;
            const fooResult = await app.handle(fooRequest);
            expectTypeOf(fooResult).toEqualTypeOf<"fooReturn">();

            const barRequest = { type: "bar" } as const;
            const barResult = await app.handle(barRequest);
            expectTypeOf(barResult).toEqualTypeOf<"barReturn">();
        });
    });

    describe("extensions", () => {
        it("can extend application with additional functionality", async () => {
            const app = newApp();
            const extension: ApplicationExtension<{
                foo(): string;
                bar(): string;
            }> = {
                extend: vi.fn().mockImplementation(() => {
                    return {
                        foo() {
                            return "foo";
                        },
                        bar() {
                            return "bar";
                        },
                    };
                }),
            };

            const extendedApp = app.install(extension);

            expect(extension.extend).toHaveBeenCalledWith(app);
            expect(extendedApp.foo()).toBe("foo");
            expect(extendedApp.bar()).toBe("bar");
        });

        test("'this' in extension methods should be the application", async () => {
            const app = newApp();
            const extension: ApplicationExtension<{
                expectThisToBeApplication(): void;
            }> = {
                extend() {
                    return {
                        expectThisToBeApplication() {
                            expect(this).toBe(app);
                        },
                    };
                },
            };

            app.install(extension).expectThisToBeApplication();
        });
    });
});
