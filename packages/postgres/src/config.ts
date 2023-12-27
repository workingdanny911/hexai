import path from "node:path";

export const DB_URL = process.env.HEXAI_DB_URL || "";

export const MIGRTAIONS_DIR = path.join(__dirname + "/../migrations");
