import { readFile, writeFile, mkdir, readdir, stat, access } from "fs/promises";
import { constants } from "fs";

export interface FileStats {
    isDirectory(): boolean;
    isFile(): boolean;
}

export interface FileSystem {
    readFile(path: string): Promise<string>;
    readdir(path: string): Promise<string[]>;
    writeFile(path: string, content: string): Promise<void>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    exists(path: string): Promise<boolean>;
    stat(path: string): Promise<FileStats>;
}

export class NodeFileSystem implements FileSystem {
    async readFile(path: string): Promise<string> {
        return readFile(path, "utf-8");
    }

    async readdir(path: string): Promise<string[]> {
        return readdir(path);
    }

    async writeFile(path: string, content: string): Promise<void> {
        await writeFile(path, content);
    }

    async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
        await mkdir(path, options);
    }

    async exists(path: string): Promise<boolean> {
        try {
            await access(path, constants.F_OK);
            return true;
        } catch {
            return false;
        }
    }

    async stat(path: string): Promise<FileStats> {
        return stat(path);
    }
}

export const nodeFileSystem = new NodeFileSystem();
