import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    plugins: [tsconfigPaths()],
    resolve: {
        alias: {
            "@hexaijs/core": path.resolve(__dirname, "packages/core/src"),
            "@hexaijs/postgres": path.resolve(
                __dirname,
                "packages/postgres/src"
            ),
        },
    },
    test: {
        setupFiles: ["./vitest.setup.js"],
        env: {
            NODE_ENV: "test",
            RUNNING_HEXAI_TESTS: "true",
        },
        typecheck: true,
        watch: false,
    },
});
