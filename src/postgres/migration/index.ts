import * as pg from "pg";

import { DB_URL } from "Hexai/config";

export async function runMigration() {
    const client = new pg.Client({
        connectionString: DB_URL,
    });
}
