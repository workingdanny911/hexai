import path from "node:path";
import { fileURLToPath } from "node:url";

import { PostgresConfig } from "./config/index.js";
import { runMigrations } from "./run-migrations.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECTION_MIGRATIONS_DIR = path.join(
    __dirname,
    "../projection-migrations"
);

export async function runProjectionMigrations(dbUrl: string | PostgresConfig) {
    await runMigrations({
        dir: PROJECTION_MIGRATIONS_DIR,
        url: dbUrl,
        namespace: "projection",
    });
}
