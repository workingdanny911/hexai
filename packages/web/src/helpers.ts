export class ListeningURL {
    private host = "localhost";
    private port!: number;

    constructor(value: number | string) {
        if (!value) {
            throw new Error("port or url(host:port) needed");
        }

        if (typeof value === "number") {
            this.port = value;
        } else {
            if (value.includes(":")) {
                this.host = value.split(":")[0];
                this.port = parseInt(value.split(":")[1]);
            } else {
                this.port = parseInt(value);
            }
        }
    }

    public getHost(): string {
        return this.host;
    }

    public getPort(): number {
        return this.port;
    }
}
