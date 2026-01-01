import path from "node:path";

import { postgresConfig } from "@/config";
import { defineConfig } from "@hexaijs/utils/config";

export const getTestConfig = defineConfig({
    db: postgresConfig("HEXAI_DB"),
    migrationsDir: path.join(__dirname + "/../migrations"),
});
