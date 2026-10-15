module.exports = {
    root: true,
    extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
    parser: "@typescript-eslint/parser",
    parserOptions: { project: ["./tsconfig.json"] },
    plugins: ["@typescript-eslint"],
    ignorePatterns: [
        "**/*.spec.ts",
        "**/*.test.ts",
        "*.config.ts",
        "vitest.workspace.ts",
        "dist/",
        "*.js",
        // Fixture projects are test inputs that the generators read.
        "**/fixtures/**",
    ],
    rules: {
        "@typescript-eslint/no-explicit-any": "off",
        // A leading underscore marks a parameter that is unused on purpose.
        "@typescript-eslint/no-unused-vars": [
            "error",
            { argsIgnorePattern: "^_" },
        ],
        // `while (true)` with an explicit break is an intended loop.
        "no-constant-condition": ["error", { checkLoops: false }],
    },
};
