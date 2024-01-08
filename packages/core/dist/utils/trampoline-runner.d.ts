/// <reference types="node" />
import EventEmitter from "node:events";
export declare class TrampolineRunner extends EventEmitter {
    protected interval: number;
    private static INTERVAL;
    private _execBody?;
    protected shouldStop: boolean;
    protected currentRun: number;
    protected currentState: "not running" | "running" | "stopped";
    protected isRunning: boolean;
    constructor(interval?: number);
    run(runFor?: number): Promise<void>;
    private doRun;
    private getExecutionBody;
    private determineShouldStop;
    private doStop;
    private restAndRunAgain;
    protected execBody(): Promise<void>;
    stop(): Promise<unknown>;
    reset(): void;
    setExecutionBody(execBody: (runner: TrampolineRunner) => Promise<void>): void;
}
//# sourceMappingURL=trampoline-runner.d.ts.map