import axios from "axios";
import { beforeEach, describe, expect, test } from "vitest";

import { Application } from "@hexai/core";
import { SimpleMessageHandlerRegistry } from "@hexai/core/test";

import { anyAvailablePort, reservePort } from "./test";
import { ExpressExtension } from "./extension";

describe("web interface", () => {
    let port!: number;

    beforeEach(async () => {
        port = await anyAvailablePort();
    });

    async function expectResponse(
        url: string,
        expectedStatus: number,
        expectedBody?: string
    ) {
        function verify(response: axios.AxiosResponse) {
            expect(response.status).toBe(expectedStatus);

            if (expectedBody) {
                expect(response.data).toBe(expectedBody);
            }
        }

        try {
            const response = await axios.get(url);
            verify(response);
        } catch (e) {
            if (e instanceof axios.AxiosError) {
                verify(e.response!);
            } else {
                throw e;
            }
        }
    }

    function createApp() {
        const app = new Application({}, new SimpleMessageHandlerRegistry());
        return app.install(new ExpressExtension());
    }

    test("when user tries to configure web interface without defining, throws error", async () => {
        const configureWithoutDefine = () =>
            createApp().webInterface().on(port).configure();

        expect(configureWithoutDefine).toThrowError(
            /routes definition needed/i
        );
    });

    test("when user tries to configure web interface without listenOn, throws error", async () => {
        const configureWithoutListenOn = () =>
            createApp()
                .webInterface()
                .define(() => {})
                .configure();

        expect(configureWithoutListenOn).toThrowError(/url.*needed/i);
    });

    test("web interface behavior definition can be overwritten", async () => {
        const define404 = (wi: any) => {
            wi.get("*", (req: any, res: any) => {
                res.status(404).send("not found");
            });
        };
        const app = createApp();
        const wiConfig = app.webInterface().on(port);

        wiConfig
            .define((wi) => {
                wi.get("/foo", (req, res) => {
                    res.status(200).send("foo");
                });

                define404(wi);
            })
            .configure();

        wiConfig
            .define((wi) => {
                wi.get("/bar", (req, res) => {
                    res.status(200).send("bar");
                });

                define404(wi);
            })
            .configure();

        await app.start();
        await expectResponse(`http://localhost:${port}/foo`, 404, "not found");
        await expectResponse(`http://localhost:${port}/bar`, 200, "bar");
    });

    test("cannot configure web interface after start", async () => {
        const app = createApp();

        await app.start();

        const configureAfterStart = () => app.webInterface();
        expect(configureAfterStart).toThrowError(
            /cannot configure.*while application is running/i
        );
    });

    test.each([
        ["url", () => `localhost:${port}`],
        ["port number", () => port],
    ])(
        "configuring web app on - %s, and starting it",
        async (_, getListenOn) => {
            const listenOn = getListenOn();
            const app = createApp();
            app.webInterface()
                .on(listenOn)
                .define((wi) => {
                    wi.get("/some-route", (req, res) => {
                        res.status(200).send("ok");
                    });
                })
                .configure();

            await app.start();

            const url =
                typeof listenOn === "number"
                    ? `http://localhost:${listenOn}/some-route`
                    : `http://${listenOn}/some-route`;
            await expectResponse(url, 200, "ok");

            // without implementing .stop(), the test will fail
            await app.stop();
        }
    );

    test("configuration can be overwritten", async () => {
        const [port1, port2] = await Promise.all([
            anyAvailablePort(),
            anyAvailablePort(),
        ]);
        const app = createApp();
        app.webInterface().define((wi) => {
            wi.get("/some-route", (req, res) => {
                res.status(200).send("ok");
            });
        });

        app.webInterface().on(port1);
        app.webInterface().on(port2);
        app.webInterface().configure();

        await app.start();

        const requestToPort1 = axios.get(
            `http://localhost:${port1}/some-route`
        );
        // reject because the web interface is not listening on port1
        await expect(requestToPort1).rejects.toThrowError();
        await expectResponse(`http://localhost:${port2}/some-route`, 200, "ok");
    });

    test("the whole application fails to start when web interface fails to start", async () => {
        const freePort = await reservePort(port);
        const app = createApp();
        app.webInterface()
            .on(port)
            .define(() => {})
            .configure();

        await expect(() => app.start()).rejects.toThrowError(/EADDRINUSE/);

        await freePort();
    });
});
