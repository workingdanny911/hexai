import { Client, DatabaseError } from "pg";

export class PostgresLock {
    private client: Client | null = null;
    private lockId: number | null = null;

    constructor(
        private name: string,
        private expiry = 600 * 1000
    ) {}

    public setClient(client: Client) {
        this.client = client;
    }

    async acquire(): Promise<boolean> {
        if (!this.client) {
            throw new Error("client not set");
        }

        await this.client.query(
            "DELETE FROM hexai__locks WHERE expires_at < NOW()"
        );

        try {
            const result = await this.client.query(
                "INSERT INTO hexai__locks (name, expires_at) VALUES ($1, $2) RETURNING id",
                [this.name, this.getExpiry()]
            );

            this.lockId = result.rows[0].id;
            return true;
        } catch (e) {
            if (e instanceof DatabaseError && e.code === "23505") {
                return false;
            }

            throw e;
        }
    }

    private getExpiry(): Date {
        return new Date(Date.now() + this.expiry);
    }

    async release(): Promise<void> {
        if (!this.client) {
            throw new Error("client not set");
        }

        if (!this.lockId) {
            throw new Error("lock not acquired");
        }

        await this.client.query("DELETE FROM hexai__locks WHERE id = $1", [
            this.lockId,
        ]);
    }
}
