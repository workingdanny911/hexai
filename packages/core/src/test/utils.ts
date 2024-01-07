export async function waitForSeveralTicks(number = 10): Promise<void> {
    for (let i = 0; i < number; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

export async function waitFor(
    type: "ticks" | "ms" = "ticks",
    number = 10
): Promise<void> {
    if (type === "ticks") {
        await waitForSeveralTicks(number);
    } else {
        await new Promise((resolve) => setTimeout(resolve, number));
    }
}
