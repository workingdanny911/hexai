import type { ClientBase } from "pg";

import type { Checkpoint, CheckpointStatus } from "./types.js";

const TABLE_NAME = "projection__checkpoints";

export class CheckpointStore {
    async get(
        projectionName: string,
        client: ClientBase
    ): Promise<Checkpoint | null> {
        const result = await client.query<{
            projection_name: string;
            last_position: string;
            version: number;
            status: CheckpointStatus;
            updated_at: Date;
        }>(
            `SELECT projection_name, last_position, version, status, updated_at
             FROM ${TABLE_NAME}
             WHERE projection_name = $1`,
            [projectionName]
        );

        if (result.rows.length === 0) return null;

        const row = result.rows[0];
        return {
            projectionName: row.projection_name,
            lastPosition: Number(row.last_position),
            version: row.version,
            status: row.status,
            updatedAt: row.updated_at,
        };
    }

    async save(
        projectionName: string,
        position: number,
        version: number,
        client: ClientBase,
        status: CheckpointStatus = "running"
    ): Promise<void> {
        await client.query(
            `INSERT INTO ${TABLE_NAME} (projection_name, last_position, version, status, updated_at)
             VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT (projection_name)
             DO UPDATE SET last_position = $2, version = $3, status = $4, updated_at = NOW()`,
            [projectionName, position, version, status]
        );
    }

    async updateStatus(
        projectionName: string,
        status: CheckpointStatus,
        client: ClientBase
    ): Promise<void> {
        await client.query(
            `UPDATE ${TABLE_NAME} SET status = $1, updated_at = NOW() WHERE projection_name = $2`,
            [status, projectionName]
        );
    }

    async reset(projectionName: string, client: ClientBase): Promise<void> {
        await client.query(
            `DELETE FROM ${TABLE_NAME} WHERE projection_name = $1`,
            [projectionName]
        );
    }
}
