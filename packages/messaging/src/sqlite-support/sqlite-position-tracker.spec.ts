import { describe, beforeEach, expect, test } from "vitest";

import { SqlitePositionTracker } from "./sqlite-position-tracker";

describe("SqlitePositionTracker", () => {
    let tracker: SqlitePositionTracker;

    beforeEach(() => {
        tracker = new SqlitePositionTracker(":memory:");
    });

    test("saving", async () => {
        const metadata = {
            id: "1",
            stream: "test",
            position: 10,
        };

        await tracker.keepTrackOf("1", "test", 10);

        const lastPosition = await tracker.getLastPosition(
            metadata.id,
            metadata.stream
        );
        expect(lastPosition).toBe(BigInt(metadata.position));
    });

    test("updating", async () => {
        await tracker.keepTrackOf("1", "test", 10);
        await tracker.keepTrackOf("1", "test", 20);

        const lastPosition = await tracker.getLastPosition("1", "test");
        expect(lastPosition).toBe(20n);
    });

    test("-1n for non-existing tracker or stream", async () => {
        await tracker.keepTrackOf("existing-tracker", "existing-stream", 1);

        const lastPosition = await tracker.getLastPosition(
            "non-existing-tracker",
            "non-existing-stream"
        );
        expect(lastPosition).toBe(-1n);

        const lastPosition2 = await tracker.getLastPosition(
            "non-existing-tracker",
            "existing-stream"
        );
        expect(lastPosition2).toBe(-1n);

        const lastPosition3 = await tracker.getLastPosition(
            "existing-tracker",
            "non-existing-stream"
        );
        expect(lastPosition3).toBe(-1n);

        const lastPosition4 = await tracker.getLastPosition(
            "existing-tracker",
            "existing-stream"
        );
        expect(lastPosition4).toBe(1n);
    });
});
