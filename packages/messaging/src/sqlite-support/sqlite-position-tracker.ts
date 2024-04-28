import * as sqlite from "sqlite";
import sqlite3 from "sqlite3";

import { PositionTracker } from "@/position-tracker";

export class SqlitePositionTracker implements PositionTracker {
    private db!: sqlite.Database;
    private tableName = "position_tracker__positions";

    constructor(
        private filename: string,
        tableName?: string
    ) {
        if (tableName) {
            this.tableName = tableName;
        }
    }

    async keepTrackOf(
        id: string,
        stream: string,
        position: number | BigInt
    ): Promise<void> {
        await this.initialize();

        const result = await this.db.run(
            `UPDATE ${this.tableName} SET position = ? WHERE id = ? AND stream = ?`,
            [position, id, stream]
        );

        if (result.changes === 0) {
            await this.db.run(
                `INSERT INTO ${this.tableName} (id, stream, position) VALUES (?, ?, ?)`,
                [id, stream, position]
            );
        }
    }

    private async initialize() {
        if (this.db) {
            return;
        }

        this.db = await sqlite.open({
            filename: this.filename,
            driver: sqlite3.Database,
        });

        await this.db.run(
            `CREATE TABLE IF NOT EXISTS ${this.tableName}
            (
                id TEXT NOT NULL,
                stream TEXT NOT NULL,
                position INTEGER NOT NULL,
                PRIMARY KEY (id, stream)
            )`
        );
    }

    async getLastPosition(id: string, stream: string): Promise<bigint> {
        await this.initialize();

        const row = await this.db.get(
            `SELECT position FROM ${this.tableName} WHERE id = ? AND stream = ?`,
            [id, stream]
        );
        return row ? BigInt(row.position) : -1n;
    }
}
