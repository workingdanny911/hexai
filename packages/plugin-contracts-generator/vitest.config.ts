import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
            "@e2e": path.resolve(__dirname, "./e2e"),
        },
    },
    test: {
        exclude: [
            "**/node_modules/**",
            "**/dist/**",
            "**/e2e/fixtures/**", // Exclude fixture files from being treated as tests
            "**/e2e/output/**",
        ],
    },
});
