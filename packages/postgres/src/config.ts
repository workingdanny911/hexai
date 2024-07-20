import path from "node:path";

export const DB_URL =
    process.env.HEXAI_DB_URL ||
    "postgresql://postgres:postgres@localhost:5432/hexai";

export const MIGRTAIONS_DIR = path.join(__dirname + "/../migrations");
