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
    ],
    rules: {
        "@typescript-eslint/no-explicit-any": "off",
    },
};
