declare const transactionResourceKeyBrand: unique symbol;

export interface TransactionResourceKey<T> {
    readonly symbol: symbol;
    readonly description: string;
    readonly [transactionResourceKeyBrand]?: (value: T) => T;
}

export function createTransactionResourceKey<T>(
    description: string
): TransactionResourceKey<T> {
    return {
        symbol: Symbol(description),
        description,
    };
}
