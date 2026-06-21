import { describe, expect, it } from "vitest";

import { BuildPluginConfig } from "./config.js";

describe("BuildPluginConfig", () => {
    const rawConfig = {
        handlers: ["src/**/*.handler.ts"],
        applicationBuilderImportPath: "@hexaijs/application",
    };

    it("defaults generated output module specifiers to js", () => {
        const config = BuildPluginConfig.fromRawConfig(rawConfig);

        expect(config.outputModuleSpecifiers).toBe("js");
    });

    it("accepts extensionless generated output module specifiers from config", () => {
        const config = BuildPluginConfig.fromRawConfig({
            ...rawConfig,
            outputModuleSpecifiers: "extensionless",
        });

        expect(config.outputModuleSpecifiers).toBe("extensionless");
    });

    it("lets explicit options override context config", () => {
        const config = BuildPluginConfig.fromRawConfig(
            {
                ...rawConfig,
                outputModuleSpecifiers: "extensionless",
            },
            {
                outputModuleSpecifiers: "js",
            }
        );

        expect(config.outputModuleSpecifiers).toBe("js");
    });

    it("rejects invalid generated output module specifiers", () => {
        expect(() =>
            BuildPluginConfig.fromRawConfig({
                ...rawConfig,
                outputModuleSpecifiers: "cjs" as never,
            })
        ).toThrow(
            'Invalid outputModuleSpecifiers: "cjs". Expected "js" or "extensionless".'
        );
    });
});
