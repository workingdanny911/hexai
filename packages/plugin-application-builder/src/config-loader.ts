import * as fs from "fs";
import * as ts from "typescript";
import { BuildPluginConfig, RawBuildPluginConfig } from "./config";

export async function loadConfig(configPath: string): Promise<BuildPluginConfig> {
    const configSource = fs.readFileSync(configPath, "utf-8");
    const transpiledCode = transpileConfigFile(configSource);
    const moduleExports = evaluateConfigModule(transpiledCode);
    const rawConfig = extractConfigFromModule(moduleExports);
    return BuildPluginConfig.fromRawConfig(rawConfig);
}

function transpileConfigFile(source: string): string {
    const result = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
        },
    });
    return result.outputText;
}

function evaluateConfigModule(code: string): any {
    const tempModule = { exports: {} };
    const fn = new Function("module", "exports", "require", code);
    fn(tempModule, tempModule.exports, require);
    return tempModule.exports;
}

function extractConfigFromModule(moduleExports: any): RawBuildPluginConfig {
    return moduleExports.default || moduleExports;
}
