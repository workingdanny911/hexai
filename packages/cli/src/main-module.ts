import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Tells whether the module at `moduleUrl` is the script Node.js was started with.
 *
 * npm installs a package's bin as a symlink. Node.js sets `process.argv[1]` to
 * the symlink's path but loads the module from its real path, so the two paths
 * are compared after resolving symlinks.
 */
export function isMainModule(
    moduleUrl: string,
    entryScriptPath: string | undefined = process.argv[1]
): boolean {
    // A REPL or `node -e` has no entry script, and with `node -e <code> <arg>`
    // the argument need not be a file.
    if (entryScriptPath === undefined || !existsSync(entryScriptPath)) {
        return false;
    }
    return (
        realpathSync(entryScriptPath) === realpathSync(fileURLToPath(moduleUrl))
    );
}
