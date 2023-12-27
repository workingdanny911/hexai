export function parseDatabaseNameFrom(connectionString: string): string {
    const match = connectionString.match(/\/([^/]+)$/);

    if (!match) {
        throw new Error("Invalid connection string");
    }

    return match[1];
}

export function replaceDatabaseNameIn(
    connectionString: string,
    database: string
): string {
    return connectionString.replace(/\/([^/]+)$/, `/${database}`);
}
