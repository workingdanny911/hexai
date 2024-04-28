export * from "./database";
export * from "./object-registry";
export * from "./types";
export * from "./inspection";
export * from "./trampoline-runner";

export async function waitForTicks(number = 10): Promise<void> {
    for (let i = 0; i < number; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

export async function waitForMs(number = 10): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, number));
}

export async function waitFor(
    type: "ticks" | "ms" = "ticks",
    number = 10
): Promise<void> {
    if (type === "ticks") {
        await waitForTicks(number);
    } else {
        await waitForMs(number);
    }
}
