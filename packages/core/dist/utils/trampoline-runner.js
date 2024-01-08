"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrampolineRunner = void 0;
const node_events_1 = __importDefault(require("node:events"));
class TrampolineRunner extends node_events_1.default {
    interval;
    static INTERVAL = 1000;
    _execBody;
    shouldStop = false;
    currentRun = 0;
    currentState = "not running";
    isRunning = false;
    constructor(interval = TrampolineRunner.INTERVAL) {
        super();
        this.interval = interval;
    }
    async run(runFor) {
        if (this.currentState === "stopped") {
            return;
        }
        this.currentState = "running";
        await this.doRun();
        if (this.determineShouldStop(runFor)) {
            this.doStop();
        }
        else {
            await this.restAndRunAgain(runFor);
        }
    }
    async doRun() {
        try {
            await this.getExecutionBody().call(this, this);
            this.emit("ran");
        }
        catch (e) {
            this.emit("error", e);
            return;
        }
    }
    getExecutionBody() {
        return this._execBody ?? this.execBody;
    }
    determineShouldStop(runFor) {
        return (this.shouldStop ||
            (typeof runFor === "number" && ++this.currentRun >= runFor));
    }
    doStop() {
        this.currentState = "stopped";
        this.emit("stopped");
    }
    async restAndRunAgain(runFor) {
        await new Promise((resolve) => setTimeout(resolve, this.interval));
        await this.run(runFor);
    }
    async execBody() {
        throw new Error("execution body has to be set via '.setExecutionBody()'" +
            " or by extending this class and overriding 'execBody()'");
    }
    async stop() {
        const isNotRunning = this.currentState !== "running";
        if (isNotRunning) {
            return;
        }
        this.shouldStop = true;
        return await new Promise((resolve) => {
            this.on("stopped", resolve);
        });
    }
    reset() {
        this.currentState = "not running";
        this.shouldStop = false;
        this.currentRun = 0;
    }
    setExecutionBody(execBody) {
        this._execBody = execBody;
    }
}
exports.TrampolineRunner = TrampolineRunner;
//# sourceMappingURL=trampoline-runner.js.map