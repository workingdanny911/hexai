export interface Lifecycle {
    isRunning(): boolean;

    start(): Promise<void>;

    stop(): Promise<void>;
}
