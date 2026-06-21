import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { cliPlugin } from "./hexai-plugin.js";
import { useContext } from "./test.js";

import type { OutputModuleSpecifiers } from "./config.js";

describe.sequential("Application builder Hexai CLI plugin", () => {
    const sampleContext = useContext("sample-context");
    const pluginPrecedenceConfigFile = "hexai.plugin-precedence.config.ts";
    const pluginPrecedenceConfigPath = path.join(
        sampleContext.path,
        pluginPrecedenceConfigFile
    );
    const pluginPrecedenceOutputDir = path.join(
        sampleContext.path,
        "src/.plugin-precedence"
    );
    const pluginPrecedenceOutputFile = path.join(
        pluginPrecedenceOutputDir,
        "application-builder.ts"
    );

    beforeEach(() => {
        cleanPluginPrecedenceArtifacts();
    });

    afterEach(() => {
        cleanPluginPrecedenceArtifacts();
    });

    test("uses plugin output module specifier config when CLI flag is absent", async () => {
        writePluginPrecedenceConfig("extensionless");

        await cliPlugin.run(
            {
                contextPath: sampleContext.path,
                configFile: pluginPrecedenceConfigFile,
            },
            {
                outputModuleSpecifiers: "js",
            }
        );

        expectPluginPrecedenceOutputFileToContain(
            "import { CreateUserHandler } from '../create-user.handler.js'",
            "import { CreateUserCommand } from '../create-user.command.js'"
        );
        expectPluginPrecedenceOutputFileNotToContain(
            "import { CreateUserHandler } from '../create-user.handler'",
            "import { CreateUserCommand } from '../create-user.command'"
        );
    });

    test("lets CLI output module specifier flag override plugin config", async () => {
        writePluginPrecedenceConfig("js");

        await cliPlugin.run(
            {
                contextPath: sampleContext.path,
                configFile: pluginPrecedenceConfigFile,
                outputModuleSpecifiers: "extensionless",
            },
            {
                outputModuleSpecifiers: "js",
            }
        );

        expectPluginPrecedenceOutputFileToContain(
            "import { CreateUserHandler } from '../create-user.handler'",
            "import { CreateUserCommand } from '../create-user.command'"
        );
        expectPluginPrecedenceOutputFileNotToContain(
            "import { CreateUserHandler } from '../create-user.handler.js'",
            "import { CreateUserCommand } from '../create-user.command.js'"
        );
    });

    test("rejects invalid output module specifier flag values", async () => {
        await expect(
            cliPlugin.run(
                {
                    contextPath: sampleContext.path,
                    outputModuleSpecifiers: "cjs",
                },
                {}
            )
        ).rejects.toThrow(
            'Invalid --output-module-specifiers: "cjs". Expected "js" or "extensionless".'
        );
    });

    function writePluginPrecedenceConfig(
        outputModuleSpecifiers: OutputModuleSpecifiers
    ): void {
        fs.writeFileSync(
            pluginPrecedenceConfigPath,
            `export default {
    handlers: ["src/create-user.handler.ts"],
    outputFile: "src/.plugin-precedence/application-builder.ts",
    applicationBuilderImportPath: "@hexaijs/application",
    outputModuleSpecifiers: "${outputModuleSpecifiers}",
};
`
        );
    }

    function cleanPluginPrecedenceArtifacts(): void {
        if (fs.existsSync(pluginPrecedenceConfigPath)) {
            fs.unlinkSync(pluginPrecedenceConfigPath);
        }

        if (fs.existsSync(pluginPrecedenceOutputFile)) {
            fs.unlinkSync(pluginPrecedenceOutputFile);
        }

        if (fs.existsSync(pluginPrecedenceOutputDir)) {
            fs.rmdirSync(pluginPrecedenceOutputDir);
        }
    }

    function expectPluginPrecedenceOutputFileToContain(
        ...strings: string[]
    ): void {
        const content = getPluginPrecedenceOutputFileContent();
        strings.forEach((s) => expect(content).toContain(s));
    }

    function expectPluginPrecedenceOutputFileNotToContain(
        ...strings: string[]
    ): void {
        const content = getPluginPrecedenceOutputFileContent();
        strings.forEach((s) => expect(content).not.toContain(s));
    }

    function getPluginPrecedenceOutputFileContent(): string {
        expect(
            fs.existsSync(pluginPrecedenceOutputFile),
            `Output file ${pluginPrecedenceOutputFile} does not exist`
        ).toBe(true);

        return fs.readFileSync(pluginPrecedenceOutputFile, "utf-8");
    }
});
