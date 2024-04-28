import { EventStoreDBClient } from "@eventstore/db-client";

import { PositionTracker } from "@hexai/messaging";

export interface EsdbClientProvider {
    getEsdbClient(): EventStoreDBClient;
}

export interface PositionTrackerProvider {
    getPositionTracker(): PositionTracker;
}
