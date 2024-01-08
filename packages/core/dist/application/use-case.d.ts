import { CommonApplicationContext, EventPublisher } from "../application";
import { UnitOfWork } from "../infra";
import { Message } from "../message";
import { ErrorResponse } from "./error-response";
import { ApplicationContextAware } from "./application-context-aware";
import { CommandExecutor } from "./command-executor";
export declare abstract class UseCase<I = unknown, O = unknown, Ctx extends CommonApplicationContext = CommonApplicationContext> implements CommandExecutor<I, O | ErrorResponse>, ApplicationContextAware<Ctx> {
    protected applicationContext: Ctx;
    protected eventPublisher: EventPublisher<Message>;
    setApplicationContext(applicationContext: Ctx): void;
    execute(command: I): Promise<O | ErrorResponse>;
    protected abstract doExecute(command: I): Promise<O>;
    protected getUnitOfWork(): UnitOfWork;
    private static mapErrorToResponse;
    protected static errorToResponse(error: Error): ErrorResponse | undefined;
    private static defaultErrorToResponse;
}
//# sourceMappingURL=use-case.d.ts.map