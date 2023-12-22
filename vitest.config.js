import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
    plugins: [tsconfigPaths()],
    test: {
        setupFiles: ["dotenv/config"],
        env: {
            NODE_ENV: "test",
            RUNNING_HEXAI_TESTS: "true",
        },
        typecheck: true,
        watch: false,
    },
});
