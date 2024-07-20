import { Database } from "sqlite";

interface Entry {
    id: number;
    value: string;
}

export class EntryRepository {
    private static tableName = "entries";
    constructor(private client: Database) {}

    async createTable() {
        await this.client.run(
            `CREATE TABLE ${EntryRepository.tableName} (id INTEGER PRIMARY KEY, value TEXT)`
        );
    }

    async dropTable() {
        await this.client.run(
            `DROP TABLE IF EXISTS ${EntryRepository.tableName}`
        );
    }

    async add(value: Entry["value"]): Promise<Entry["id"]> {
        const { lastID } = await this.client.run(
            `INSERT INTO ${EntryRepository.tableName} (value) VALUES (?)`,
            [value]
        );

        return lastID!;
    }

    async getById(id: Entry["id"]): Promise<Entry> {
        const result = await this.client.get(
            `SELECT * FROM ${EntryRepository.tableName} WHERE id = ?`,
            [id]
        );

        if (!result) {
            throw new Error(`Entry with id ${id} not found`);
        }

        return result;
    }

    async getByValue(value: string): Promise<Entry> {
        const result = await this.client.get(
            `SELECT * FROM ${EntryRepository.tableName} WHERE value = ?`,
            [value]
        );

        if (!result) {
            throw new Error(`Entry with value ${value} not found`);
        }

        return result;
    }

    async count(): Promise<number> {
        const { count } = await this.client.get(
            `SELECT COUNT(*) as count FROM ${EntryRepository.tableName}`
        );

        return count;
    }

    async reset() {
        await this.client.run(`DELETE FROM ${EntryRepository.tableName}`);
    }
}
