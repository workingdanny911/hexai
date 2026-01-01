import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
    plugins: [tsconfigPaths()],
    test: {
        env: {
            NODE_ENV: "test",
        },
        typecheck: true,
        watch: false,
    },
});
