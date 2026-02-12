import { Message, UnitOfWork } from "@hexaijs/core";
import {
    Application,
    ErrorResult,
    EventHandlingResult,
    Result,
    SuccessResult,
} from "./application";
import { ApplicationErrorFactory } from "./error";
import { Command } from "./command";
import { Query } from "./query";

export class SimpleCompositeApplication implements Application {
    private unitOfWork?: UnitOfWork;

    constructor(
        private applicationByCommandPrefix: Record<string, Application>,
        unitOfWork?: UnitOfWork
    ) {
        this.unitOfWork = unitOfWork;
    }

    setUnitOfWork(unitOfWork: UnitOfWork) {
        this.unitOfWork = unitOfWork;
    }

    public async executeCommand<C extends Command>(
        command: C
    ): Promise<Result<C['ResultType']>> {
        const handler = this.findAppropriateApplication(
            command.getMessageType()
        );

        if (handler) {
            return handler.executeCommand(command);
        }

        return new ErrorResult(
            ApplicationErrorFactory.handlerNotFound(command)
        );
    }

    public async executeQuery<Q extends Query>(
        query: Q
    ): Promise<Result<Q['ResultType']>> {
        const handler = this.findAppropriateApplication(query.getMessageType());

        if (handler) {
            return handler.executeQuery(query);
        }

        return new ErrorResult(ApplicationErrorFactory.handlerNotFound(query));
    }

    private findAppropriateApplication(
        messageType: string
    ): Application | undefined {
        const prefixes = Object.keys(this.applicationByCommandPrefix);
        for (const prefix of prefixes) {
            if (messageType.startsWith(prefix)) {
                return this.applicationByCommandPrefix[prefix];
            }
        }
    }

    public async handleEvent(
        event: Message
    ): Promise<Result<EventHandlingResult>> {
        if (!this.unitOfWork) {
            throw new Error(
                "Unit of work not set for CompositeApplication. Set it using setUnitOfWork() method."
            );
        }

        const apps = Object.values(this.applicationByCommandPrefix);
        const throwIfError = async (app: Application) => {
            const result = await app.handleEvent(event);
            if (result.isError) {
                throw result;
            }
        };

        return await this.unitOfWork.scope(async () => {
            try {
                await Promise.all(apps.map((app) => throwIfError(app)));
            } catch (e) {
                return e as ErrorResult;
            }

            return new SuccessResult(null);
        });
    }
}
