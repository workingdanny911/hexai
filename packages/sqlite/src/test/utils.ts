import type { Database } from "sqlite";

export async function getSqliteConnection(
    filename = ":memory:"
): Promise<Database> {
    const sqlite = await import("sqlite");
    const sqlite3 = await import("sqlite3");
    return await sqlite.open({
        filename,
        driver: sqlite3.default.Database,
    });
}
