import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { isMainModule } from "./main-module.js";

describe("isMainModule", () => {
    let dir: string;
    let modulePath: string;
    let moduleUrl: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "main-module-"));
        modulePath = join(dir, "cli.js");
        await writeFile(modulePath, "");
        moduleUrl = pathToFileURL(modulePath).href;
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it("is true when Node.js runs the module itself", () => {
        expect(isMainModule(moduleUrl, modulePath)).toBe(true);
    });

    it("is true when Node.js runs the module through a symlink, as an npm-installed bin does", async () => {
        const binPath = join(dir, "hexai");
        await symlink(modulePath, binPath);

        expect(isMainModule(moduleUrl, binPath)).toBe(true);
    });

    it("is false when Node.js runs another script", async () => {
        const otherScriptPath = join(dir, "other.js");
        await writeFile(otherScriptPath, "");

        expect(isMainModule(moduleUrl, otherScriptPath)).toBe(false);
    });

    it("is false without an entry script, as in a REPL", () => {
        expect(isMainModule(moduleUrl, undefined)).toBe(false);
    });

    it("is false when the entry argument is not a file", () => {
        expect(isMainModule(moduleUrl, join(dir, "missing.js"))).toBe(false);
    });
});
