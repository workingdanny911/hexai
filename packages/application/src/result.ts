export class SuccessResult<R> {
    public readonly isSuccess = true;
    public readonly isError = false;

    constructor(public readonly data: R) {}

    getOrThrow(): R {
        return this.data;
    }
}

export class ErrorResult<E extends Error = Error> {
    public readonly isSuccess = false;
    public readonly isError = true;

    constructor(public readonly error: E) {}

    getOrThrow(): never {
        throw this.error;
    }
}

export type Result<R, E extends Error = Error> = (
    | SuccessResult<R>
    | ErrorResult<E>
) & {
    getOrThrow(): R;
};
