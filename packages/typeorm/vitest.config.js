import swc from "unplugin-swc";
import { defineConfig, mergeConfig } from "vitest/config";
import sharedConfig from "../../vitest.config.js";

export default mergeConfig(
    sharedConfig,
    defineConfig({
        plugins: [swc.vite()],
        esbuild: false,
    })
);
