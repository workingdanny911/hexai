import { beforeEach, describe, expect, it } from "vitest";
import { DummyMessage } from "@hexai/core/test";

import { esdbClient } from "@/test-fixtures";
import { EsdbHelper } from "@/esdb-helper";
import { EsdbOutboundChannel } from "@/esdb-outbound-channel";

const esdb = new EsdbHelper(esdbClient);

describe("EsdbOutboundChannel", () => {
    const channel = new EsdbOutboundChannel("test-pub-stream");
    channel.setApplicationContext({
        getEsdbClient: () => esdbClient,
    });

    beforeEach(async () => {
        await esdb.deleteStream("test-pub-stream");
    });

    async function readStream() {
        return esdb.readStream("test-pub-stream");
    }

    it("appends received message to stream", async () => {
        const message = DummyMessage.create();

        await channel.send(message);

        const events = await readStream();
        expect(events).toEqual([message]);
    });
});
