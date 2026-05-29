import dotenv from "dotenv";

const shellEnv = { ...process.env };

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.test", override: true });

Object.assign(process.env, shellEnv);
