import path from "node:path";
import { fileURLToPath } from "node:url";

import { runMigrations } from "@/run-migrations";
import { PostgresConfig } from "@/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "../migrations");

export async function runHexaiMigrations(dbUrl: string | PostgresConfig) {
    await runMigrations({
        dir: MIGRATIONS_DIR,
        url: dbUrl,
        namespace: "hexai",
    });
}
