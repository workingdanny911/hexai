import EventEmitter from "node:events";

export class TrampolineRunner extends EventEmitter {
    private static INTERVAL = 1000;

    private _execBody?: (runner: TrampolineRunner) => Promise<void>;
    protected shouldStop = false;
    protected currentRun = 0;
    protected currentState: "not running" | "running" | "stopped" =
        "not running";
    protected isRunning = false;

    constructor(protected interval = TrampolineRunner.INTERVAL) {
        super();
    }

    public async run(runFor?: number) {
        if (this.currentState === "stopped") {
            return;
        }
        this.currentState = "running";

        await this.doRun();

        if (this.determineShouldStop(runFor)) {
            this.doStop();
        } else {
            await this.restAndRunAgain(runFor);
        }
    }

    private async doRun() {
        try {
            await this.getExecutionBody().call(this, this);
            this.emit("ran");
        } catch (e) {
            this.emit("error", e);
            return;
        }
    }

    private getExecutionBody() {
        return this._execBody ?? this.execBody;
    }

    private determineShouldStop(runFor?: number) {
        return (
            this.shouldStop ||
            (typeof runFor === "number" && ++this.currentRun >= runFor)
        );
    }

    private doStop() {
        this.currentState = "stopped";
        this.emit("stopped");
    }

    private async restAndRunAgain(runFor: number | undefined) {
        await new Promise((resolve) => setTimeout(resolve, this.interval));
        await this.run(runFor);
    }

    protected async execBody() {
        throw new Error(
            "execution body has to be set via '.setExecutionBody()'" +
                " or by extending this class and overriding 'execBody()'"
        );
    }

    public async stop() {
        const isNotRunning = this.currentState !== "running";
        if (isNotRunning) {
            return;
        }

        this.shouldStop = true;
        return await new Promise((resolve) => {
            this.on("stopped", resolve);
        });
    }

    public reset() {
        this.currentState = "not running";
        this.shouldStop = false;
        this.currentRun = 0;
    }

    public setExecutionBody(
        execBody: (runner: TrampolineRunner) => Promise<void>
    ) {
        this._execBody = execBody;
    }
}
