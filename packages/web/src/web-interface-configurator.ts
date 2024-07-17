import express, { Express } from "express";
import { Application } from "@hexai/core";

import { WEB_INTERFACE } from "./constants";
import { WebInterface } from "./web-interface";
import { ListeningURL } from "./helpers";

export class WebInterfaceConfigurator<App extends Application> {
    private listenOn!: number | string;
    private webInterface!: Express;

    constructor(private app: App) {}

    public on(listenOn: number | string): this {
        this.listenOn = listenOn;
        return this;
    }

    public define(config: (wi: Express) => void): this {
        this.webInterface = express();

        config(this.webInterface);

        return this;
    }

    public configure(): void {
        if (!this.webInterface) {
            throw new Error("Routes definition needed");
        }

        this.app.registerCompanion(
            WEB_INTERFACE,
            new WebInterface(this.webInterface, new ListeningURL(this.listenOn))
        );
    }
}
