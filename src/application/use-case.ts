import { ValidationError } from "Hexai/domain";
import { UnitOfWork } from "Hexai/infra";
import { UnitOfWorkHolder } from "Hexai/helpers";
import { Command } from "Hexai/message";
import {
    ErrorResponse,
    unknownErrorResponse,
    validationErrorResponse,
} from "Hexai/application/error-response";

export abstract class UseCase<
    I extends Command = Command,
    O = unknown,
    Ctx extends UnitOfWorkHolder = UnitOfWorkHolder,
> {
    constructor(protected readonly context: Ctx) {}

    public async execute(command: I): Promise<O | ErrorResponse> {
        try {
            return await this.doExecute(command);
        } catch (e) {
            return (this.constructor as any).mapErrorToResponse(e);
        }
    }

    protected abstract doExecute(command: I): Promise<O>;

    protected getContext(): Ctx {
        return this.context;
    }

    protected getUnitOfWork(): UnitOfWork {
        return this.context.getUnitOfWork();
    }

    private static mapErrorToResponse(error: Error): ErrorResponse {
        return (
            this.errorToResponse(error) ?? this.defaultErrorToResponse(error)
        );
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protected static errorToResponse(error: Error): ErrorResponse | undefined {
        return;
    }

    private static defaultErrorToResponse(error: Error): ErrorResponse {
        if (error instanceof ValidationError) {
            return validationErrorResponse({
                [error.field]: [error.code, error.message],
            });
        }

        return unknownErrorResponse(error.message);
    }
}
