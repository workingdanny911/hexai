export interface PositionTracker {
    keepTrackOf(
        id: string,
        stream: string,
        position: number | BigInt
    ): Promise<void>;

    getLastPosition(id: string, stream: string): Promise<bigint>;
}
