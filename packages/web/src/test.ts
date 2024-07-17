import { createServer } from "http";

export async function anyAvailablePort(): Promise<number> {
    const server = createServer();

    return new Promise((resolve) => {
        server.listen(0, () => {
            const port = (server.address() as any).port;
            server.close(() => resolve(port));
        });
    });
}

export async function reservePort(port: number): Promise<() => Promise<void>> {
    const server = createServer();
    await new Promise<void>((resolve) => {
        server.listen(port, "localhost", () => {
            resolve();
        });
    });

    return async () => {
        return new Promise((resolve) => {
            server.close(() => {
                resolve();
            });
        });
    };
}
