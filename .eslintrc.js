module.exports = {
    extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
    parser: "@typescript-eslint/parser",
    parserOptions: { project: ["./tsconfig.json"] },
    plugins: ["@typescript-eslint"],
    ignorePatterns: ["**/*.spec.ts", "*.config.js", ".*rc.js", "dist/"],
    rules: {
        "@typescript-eslint/no-explicit-any": "off",
    },
};
