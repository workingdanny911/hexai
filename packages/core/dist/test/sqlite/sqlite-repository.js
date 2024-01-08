"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SqliteRepository = void 0;
const domain_1 = require("../../domain");
class SqliteRepository {
    db;
    namespace;
    hydrate;
    dehydrate;
    constructor(db, { namespace, hydrate, dehydrate, }) {
        this.db = db;
        this.namespace = namespace;
        this.hydrate = hydrate;
        this.dehydrate = dehydrate;
    }
    async get(id) {
        await this.ensureTableExists();
        const row = await this.db.get(`SELECT * FROM ${this.namespace} WHERE id = ?`, id.getValue());
        if (!row) {
            throw new domain_1.ObjectNotFoundError(`entity with id '${id.getValue()}' not found`);
        }
        return this.hydrate(JSON.parse(row.data));
    }
    async add(entity) {
        await this.ensureTableExists();
        try {
            await this.db.run(`INSERT INTO ${this.namespace} (id, data)
                 VALUES (?, ?)`, entity.getId().getValue(), JSON.stringify(this.dehydrate(entity)));
        }
        catch (e) {
            if (e.message.includes("UNIQUE constraint failed")) {
                throw new domain_1.DuplicateObjectError(`entity with id '${entity
                    .getId()
                    .getValue()}' already exists`);
            }
            throw e;
        }
    }
    async update(entity) {
        await this.ensureTableExists();
        const result = await this.db.run(`UPDATE ${this.namespace}
                 SET data = ?
                 WHERE id = ?`, JSON.stringify(this.dehydrate(entity)), entity.getId().getValue());
        if (result.changes === 0) {
            throw new domain_1.ObjectNotFoundError(`entity with id '${entity.getId().getValue()}' not found`);
        }
    }
    async count() {
        await this.ensureTableExists();
        const result = await this.db.get(`SELECT COUNT(*) AS count FROM ${this.namespace}`);
        return result.count;
    }
    async ensureTableExists() {
        await this.db.run(`
            CREATE TABLE IF NOT EXISTS ${this.namespace} (
                id TEXT NOT NULL PRIMARY KEY UNIQUE,
                data TEXT NOT NULL
            )
        `);
    }
}
exports.SqliteRepository = SqliteRepository;
//# sourceMappingURL=sqlite-repository.js.map