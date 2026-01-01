import * as ts from "typescript";
import { resolve, dirname, join } from "path";

export interface PathAliasConfig {
    readonly baseUrl: string;
    readonly paths: Map<string, string[]>;
}

export class TsconfigLoader {
    async load(tsconfigPath: string): Promise<PathAliasConfig> {
        const absolutePath = resolve(tsconfigPath);
        const configDir = dirname(absolutePath);

        const parsed = ts.getParsedCommandLineOfConfigFile(
            absolutePath,
            {},
            {
                ...ts.sys,
                onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
                    throw new Error(
                        ts.flattenDiagnosticMessageText(
                            diagnostic.messageText,
                            "\n"
                        )
                    );
                },
            }
        );

        if (!parsed) {
            throw new Error(`Failed to parse tsconfig: ${absolutePath}`);
        }

        const baseUrl = parsed.options.baseUrl ?? configDir;
        const paths = new Map<string, string[]>();

        if (parsed.options.paths) {
            for (const [alias, targets] of Object.entries(
                parsed.options.paths
            )) {
                const resolvedTargets = (targets as string[]).map((target) =>
                    join(baseUrl, target)
                );
                paths.set(alias, resolvedTargets);
            }
        }

        return { baseUrl, paths };
    }
}
