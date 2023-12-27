import { afterEach, describe, expect, test, vi } from "vitest";
import { Express } from "express";
import axios from "axios";

import { WebServerForTest } from "./web-server-for-test";

type HttpMethod = "get" | "post" | "put" | "delete" | "patch" | "options";

describe.sequential("web server for test", () => {
    const port = 60000;
    const handler = vi.fn<[Express], void>((app) => {
        app.get("/", (_, res) => {
            res.send("hello world");
        });
    });
    const server = new WebServerForTest(handler);

    afterEach(async () => {
        await server.shutdown();
        vi.restoreAllMocks();
    });

    function bindHandler(fn: (app: Express) => void) {
        handler.mockImplementation(fn);
    }

    async function sendRequest(
        url: string,
        {
            method = "get",
            contentType = "text/plain",
            body,
        }: {
            method?: HttpMethod;
            contentType?: string;
            body?: any;
        } = {}
    ) {
        const response = await axios({
            method,
            url,
            data: body,
            headers: {
                "Content-Type": contentType,
            },
        });

        return response.data;
    }

    async function expectText(
        text: string,
        {
            url,
            method = "get",
            contentType = "text/plain",
        }: {
            url: string;
            method?: HttpMethod;
            contentType?: string;
        }
    ) {
        const response = await sendRequest(url, { method });
        expect(response).toBe(text);
    }

    test("starting server", async () => {
        const info = await server.start(port);

        expect(server.isRunning).toBe(true);
        expect(info.port).toBe(port);
        await expectText("hello world", {
            url: `http://localhost:${info.port}/`,
        });
    });

    test("when port is not provided", async () => {
        const info = await server.start();

        await expectText("hello world", {
            url: `http://localhost:${info.port}/`,
        });
    });

    test("when already started", async () => {
        await server.start();

        await expect(server.start()).rejects.toThrowError(
            /is already running/i
        );
    });

    test.each(["get", "post", "put", "delete", "patch", "options"] as const)(
        "http method - %s",
        async (method) => {
            bindHandler((app) => {
                app[method]("/", (_, res) => {
                    res.send("hello world");
                });
            });

            const info = await server.start();

            await expectText("hello world", {
                url: `http://localhost:${info.port}/`,
                method,
            });
        }
    );

    test.each(["application/json", "application/x-www-form-urlencoded"])(
        "body parsing - %s",
        async (contentType) => {
            let body: any;
            bindHandler((app) => {
                app.post("/", (req, res) => {
                    body = req.body;
                    res.end();
                });
            });

            const info = await server.start();

            await sendRequest(`http://localhost:${info.port}/`, {
                method: "post",
                contentType,
                body: { hello: "world" },
            });
            expect(body).toEqual({ hello: "world" });
        }
    );
});
