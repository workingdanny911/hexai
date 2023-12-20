export async function waitForSeveralTicks(number = 10): Promise<void> {
    for (let i = 0; i < number; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}
