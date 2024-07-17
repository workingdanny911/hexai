import { Server } from "node:http";

import { Express } from "express";
import { Lifecycle } from "@hexai/core";

import { ListeningURL } from "./helpers";

export class WebInterface implements Lifecycle {
    private server: Server | null = null;

    constructor(
        private webApp: Express,
        private url: ListeningURL
    ) {}

    public start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server = this.webApp.listen(
                this.url.getPort(),
                this.url.getHost()
            );

            const removeCallbacks = () => {
                this.server?.removeListener("listening", listenCallback);
                this.server?.removeListener("error", errorCallback);
            };
            const listenCallback = () => {
                resolve();
                removeCallbacks();
            };
            const errorCallback = (err: any) => {
                reject(err);
                removeCallbacks();
            };
            this.server.on("listening", listenCallback);
            this.server.on("error", errorCallback);
        });
    }

    public async stop(): Promise<void> {
        const server = this.server;

        if (server) {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    }
}
