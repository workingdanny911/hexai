import type { Currency } from "./types";

/**
 * Base value object class - internal base class that should be extracted
 */
export abstract class ValueObject<T> {
    constructor(protected readonly _value: T) {}

    equals(other: ValueObject<T>): boolean {
        return this._value === other._value;
    }
}

/**
 * Internal base class - should be extracted along with derived classes
 */
export abstract class Money {
    constructor(
        public readonly amount: number,
        public readonly currency: Currency
    ) {}

    add(other: Money): Money {
        if (this.currency !== other.currency) {
            throw new Error("Currency mismatch");
        }
        return new (this.constructor as new (
            amount: number,
            currency: Currency
        ) => Money)(this.amount + other.amount, this.currency);
    }
}

/**
 * Extends internal base class - both should be extracted
 */
export class LessonPrice extends Money {
    constructor(amount: number, currency: Currency) {
        super(amount, currency);

        if (!this.validate()) {
            throw new Error("Invalid lesson price");
        }
    }

    validate(): boolean {
        return this.amount > 0;
    }

    applyDiscount(percent: number): LessonPrice {
        const discounted = this.amount * (1 - percent / 100);
        return new LessonPrice(discounted, this.currency);
    }
}

/**
 * Extends internal base class - both should be extracted
 */
export class LessonCredit extends ValueObject<number> {
    constructor(public readonly value: number) {
        super(value);

        if (!this.validate()) {
            throw new Error("Invalid lesson credit");
        }
    }

    validate(): boolean {
        return this.value > 0 && this.value <= 100;
    }

    add(other: LessonCredit): LessonCredit {
        return new LessonCredit(this.value + other.value);
    }
}
