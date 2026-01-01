import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";

export function loadEnvFiles({
    basePath,
    nodeEnv,
}: {
    basePath?: string;
    nodeEnv?: string;
} = {}): void {
    const basePath_ = basePath ?? process.cwd();
    const nodeEnv_ = nodeEnv ?? process.env.NODE_ENV ?? "development";

    // List of environment files in the order of precedence
    const envFiles = [
        ".env", // Default
        ".env.local", // Local overrides
        `.env.${nodeEnv_}`, // Environment-specific settings
        `.env.${nodeEnv_}.local`, // Local overrides of environment-specific settings
    ];

    // Function to load a single env file
    const loadEnvFile = (filePath: string) => {
        if (fs.existsSync(filePath)) {
            dotenv.config({
                path: filePath,
            });
        }
    };

    // Load env files in order of precedence
    envFiles.reverse().forEach((file) => {
        const filePath = path.resolve(basePath_, file);
        loadEnvFile(filePath);
    });
}
