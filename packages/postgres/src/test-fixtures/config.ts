import path from "node:path";
import { fileURLToPath } from "node:url";

import { postgresConfig } from "@/config";
import { defineConfig } from "ezcfg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const getTestConfig = defineConfig({
    db: postgresConfig("HEXAI_DB"),
    migrationsDir: path.join(__dirname, "../migrations"),
});
