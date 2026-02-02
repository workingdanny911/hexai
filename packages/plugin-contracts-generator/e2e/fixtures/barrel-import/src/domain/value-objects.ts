export class Email {
    constructor(public readonly value: string) {}

    static create(value: string): Email {
        return new Email(value);
    }
}
