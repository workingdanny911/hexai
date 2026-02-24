import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";

export function getSqliteConnection(
    filename = ":memory:"
): DatabaseInstance {
    return new Database(filename);
}
