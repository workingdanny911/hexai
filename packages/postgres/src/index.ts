import { runMigrations } from "@/run-migrations";
import { MIGRTAIONS_DIR } from "@/config";

export * from "./postgres-unit-of-work";
export * from "./run-migrations";
export {
    ClientWrapper,
    DatabaseManager,
    TableManager,
    ensureConnection,
} from "./helpers";
export * from "./postgres-idempotency-support";
export * from "./postgres-outbox";
export * from "./postgres-outbox-inbound-channel-adapter";

export async function runHexaiMigrations(dbUrl: string) {
    await runMigrations({
        dir: MIGRTAIONS_DIR,
        url: dbUrl,
        namespace: "hexai",
    });
}
