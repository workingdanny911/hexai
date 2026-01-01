import { expect } from "vitest";

import { ErrorResult, SuccessResult } from "@/application";
import { ApplicationError } from "@/error";

export function expectSuccessResult<T = any>(
    result: unknown
): asserts result is SuccessResult<T> {
    expect(result).toBeInstanceOf(SuccessResult);
}

export function expectErrorResult(
    result: unknown
): asserts result is ErrorResult<ApplicationError> {
    expect(result).toBeInstanceOf(ErrorResult);
}

export function expectApplicationError(
    result: unknown,
    {
        message,
        cause,
    }: Partial<{
        message: string;
        cause: Error;
    }> = {}
) {
    expectErrorResult(result);
    expect(result.isError).toBe(true);
    expect(result.error).toBeInstanceOf(ApplicationError);

    if (message) {
        expect(result.error.message).toBe(message);
    }

    if (cause) {
        expect(result.error.cause).toBe(cause);
    }
}

export async function expectExecutionTimeLessThan(
    fn: () => Promise<any>,
    timeMs: number
) {
    const startTime = Date.now();
    await fn();
    const endTime = Date.now();

    expect(endTime - startTime).toBeLessThan(timeMs);
}
