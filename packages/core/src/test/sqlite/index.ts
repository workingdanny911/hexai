export * from "./sqlite-repository";
export * from "./sqlite-unit-of-work";

import * as sqlite from "sqlite";

export async function getSqliteConnection(
    filename = ":memory:"
): Promise<sqlite.Database> {
    return await require("sqlite").open({
        filename,
        driver: require("sqlite3").Database,
    });
}
