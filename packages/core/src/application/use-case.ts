import { ValidationError } from "@/domain";
import { CommonApplicationContext, EventPublisher } from "@/application";
import { UnitOfWork } from "@/infra";
import { Message } from "@/message";

import {
    ErrorResponse,
    unknownErrorResponse,
    validationErrorResponse,
} from "./error-response";
import { ApplicationContextAware } from "./application-context-aware";
import { CommandExecutor } from "./command-executor";

export abstract class UseCase<
        I = unknown,
        O = unknown,
        Ctx extends CommonApplicationContext = CommonApplicationContext,
    >
    implements
        CommandExecutor<I, O | ErrorResponse>,
        ApplicationContextAware<Ctx>
{
    protected applicationContext!: Ctx;
    protected eventPublisher!: EventPublisher<Message>;

    public setApplicationContext(applicationContext: Ctx): void {
        this.applicationContext = applicationContext;
        this.eventPublisher = applicationContext.getEventPublisher();
    }

    public async execute(command: I): Promise<O | ErrorResponse> {
        try {
            return await this.doExecute(command);
        } catch (e) {
            return (this.constructor as any).mapErrorToResponse(e);
        }
    }

    protected abstract doExecute(command: I): Promise<O>;

    protected getUnitOfWork(): UnitOfWork {
        return this.applicationContext.getUnitOfWork();
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
