import { Client, DatabaseError } from "pg";

export class PostgresLock {
    private client!: Client;
    private lockId: number | null = null;

    constructor(
        private name: string,
        private expiry = 600 * 1000
    ) {}

    public setClient(client: Client) {
        this.client = client;
    }

    async acquire(): Promise<boolean> {
        this.assertClient();

        if (this.hasLock()) {
            await this.extendExpiration();
            return true;
        }

        await this.removeExpiredLocks();

        try {
            this.lockId = await this.tryToAcquire();
            return true;
        } catch (e) {
            const isAlreadyAcquired =
                e instanceof DatabaseError && e.code === "23505";
            if (isAlreadyAcquired) {
                return false;
            }

            throw e;
        }
    }

    private assertClient() {
        if (!this.client) {
            throw new Error("client not set");
        }
    }

    private async tryToAcquire(): Promise<number> {
        const result = await this.client.query(
            `INSERT INTO hexai__locks (name, expires_at) VALUES ($1, (NOW() + INTERVAL '${this.expiry} milliseconds')) RETURNING id`,
            [this.name]
        );

        return result.rows[0].id;
    }

    private async removeExpiredLocks() {
        await this.client.query(
            "DELETE FROM hexai__locks WHERE expires_at < NOW()"
        );
    }

    private async extendExpiration() {
        await this.client.query(
            `UPDATE hexai__locks SET expires_at = NOW() + INTERVAL '${this.expiry} milliseconds' WHERE id = $1`,
            [this.lockId]
        );
    }

    private hasLock(): boolean {
        return this.lockId !== null;
    }

    async release(): Promise<void> {
        this.assertClient();

        if (!this.hasLock()) {
            throw new Error("lock not acquired");
        }

        await this.doRelease();
    }

    private async doRelease(): Promise<void> {
        await this.client.query("DELETE FROM hexai__locks WHERE id = $1", [
            this.lockId,
        ]);
    }
}
