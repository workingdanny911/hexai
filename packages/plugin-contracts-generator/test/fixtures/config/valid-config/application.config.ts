export default {
    // Existing config (should be ignored by ConfigLoader)
    handlers: ["./handlers/*.ts"],
    outputFile: "dist/handlers.ts",

    // Contracts config (extraction target)
    contracts: {
        contexts: [
            {
                name: "lecture",
                sourceDir: "src",
            },
        ],
        pathAliasRewrites: {
            "@/": "@libera/",
        },
    },
};
