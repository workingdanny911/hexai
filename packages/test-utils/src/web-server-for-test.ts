import http from "http";
import { Express } from "express";
import { AddressInfo } from "node:net";

export class WebServerForTest {
    private server: http.Server | null = null;

    constructor(private handler: (app: Express) => void) {}

    public get isRunning(): boolean {
        return this.server !== null;
    }

    async start(port?: number) {
        if (this.isRunning) {
            const address = this.server!.address() as AddressInfo;
            throw new Error(
                `Server is already running on port ${address.port}`
            );
        }

        const app = this.makeApp();

        const [server, address] = await this.startServer(app, port);
        this.server = server;

        return {
            port: address.port,
        };
    }

    private makeApp(): Express {
        const express = require("express");
        const app = express();

        app.use(express.json());
        app.use(express.urlencoded({ extended: true }));

        this.handler(app);
        return app;
    }

    async startServer(
        app: Express,
        port?: number
    ): Promise<[http.Server, AddressInfo]> {
        const server = await new Promise<http.Server>((resolve, reject) => {
            try {
                const server = app.listen(port, () => {
                    resolve(server);
                });
            } catch (e) {
                reject(e);
            }
        });

        return [server, server.address() as AddressInfo];
    }

    async shutdown() {
        if (this.server) {
            await new Promise((resolve) => this.server!.close(resolve));
        }

        this.server = null;
    }
}
