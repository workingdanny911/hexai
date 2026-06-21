export class ApplicationBuilder {
    withCommandHandler(
        _message: unknown,
        _factory: () => unknown
    ): ApplicationBuilder {
        return this;
    }

    withEventHandler(
        _factory: () => unknown,
        _name?: string
    ): ApplicationBuilder {
        return this;
    }

    withQueryHandler(
        _message: unknown,
        _factory: () => unknown
    ): ApplicationBuilder {
        return this;
    }
}
