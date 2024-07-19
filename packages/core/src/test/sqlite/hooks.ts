import { unlink } from "node:fs/promises";

import { beforeAll } from "vitest";
import * as sqlite from "sqlite";

import { getSqliteConnection } from "./conn";

export function useSqliteFileDatabase(
    filename: string
): () => Promise<sqlite.Database> {
    const setupComplete = useTempFile(filename);

    return async () => {
        await setupComplete;
        return getSqliteConnection(filename);
    };
}

async function deleteFile(path: string) {
    try {
        await unlink(path);
    } catch (e) {
        if ((e as any)?.code !== "ENOENT") {
            throw e;
        }
    }
}

function useTempFile(filename: string): Promise<void> {
    return new Promise((resolve) => {
        beforeAll(async () => {
            await deleteFile(filename);
            resolve();

            return async () => {
                await deleteFile(filename);
            };
        });
    });
}
