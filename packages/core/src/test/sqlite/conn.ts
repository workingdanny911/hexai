import * as sqlite from "sqlite";
import * as sqlite3 from "sqlite3";

const DEFAULT_MODE =
    sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE | sqlite3.OPEN_FULLMUTEX;

export function getSqliteInMemoryConnection(
    sharedCache = false
): Promise<sqlite.Database> {
    let mode = DEFAULT_MODE;
    if (sharedCache) {
        mode |= sqlite3.OPEN_SHAREDCACHE;
    }

    return getSqliteConnection(":memory:", mode);
}

export async function getSqliteConnection(
    filename = ":memory:",
    mode = DEFAULT_MODE
): Promise<sqlite.Database> {
    return await require("sqlite").open({
        filename,
        mode,
        driver: require("sqlite3").Database,
    });
}
