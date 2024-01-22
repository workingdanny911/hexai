/* eslint-disable @typescript-eslint/no-unused-vars */
import _ from "lodash";
import { C } from "ts-toolbelt";

import { isApplicationContextAware } from "./inspections";
import { CommandExecutorRegistry } from "./command-executor-registry";
import { CommandExecutor } from "./command-executor";
import { systemErrorResponse, validationErrorResponse } from "./error-response";
import { CommonApplicationContext } from "./application-context";

interface ErrorObserver<Message = any> {
    (message: Message, error: Error): void | Promise<void>;
}

export abstract class AbstractApplication<
    Ctx extends CommonApplicationContext<any, any>,
    Cmd extends object = object,
> {
    protected errorObservers: ErrorObserver[] = [];

    protected constructor(
        protected context: Ctx,
        protected executorRegistry: CommandExecutorRegistry<any, Cmd>
    ) {}

    protected clone(): typeof this {
        return _.clone(this);
    }

    public withExecutor<E extends CommandExecutor<Cmd>>(
        key: string | object | C.Class,
        executor: E
    ): AbstractApplication<Ctx, Cmd> {
        this.executorRegistry.register(key, executor);

        return this;
    }

    async execute(command: Cmd): Promise<any> {
        const executor = this.executorRegistry.get(command);
        if (!executor) {
            return validationErrorResponse({
                "*": "UNSUPPORTED_MESSAGE_TYPE",
            });
        }

        await this.beforeExecute(executor, command);

        this.injectApplicationContextTo(executor);
        return await this.doExecute(command, executor);
    }

    protected async beforeExecute(
        executor: CommandExecutor,
        command: Cmd
    ): Promise<void> {
        return;
    }

    protected injectApplicationContextTo(handler: CommandExecutor): void {
        if (isApplicationContextAware(handler)) {
            handler.setApplicationContext(this.context);
        }
    }

    protected async doExecute(
        command: Cmd,
        executor: CommandExecutor
    ): Promise<any> {
        const eventPublisher = this.context.getEventPublisher();
        const eventPublishingContext = this.makeEventPublishingContext(command);

        try {
            return await eventPublisher.bindContext(
                eventPublishingContext,
                () => executor.execute(command)
            );
        } catch (e) {
            const error = e as Error;
            this.notifyErrorObservers(command, error);
            return systemErrorResponse((e as Error).message);
        }
    }

    protected abstract makeEventPublishingContext(command: Cmd): any;

    public onError(observer: ErrorObserver<Cmd>): void {
        this.errorObservers.push(observer);
    }

    protected notifyErrorObservers(command: Cmd, error: Error): void {
        this.errorObservers.forEach((observer) => observer(command, error));
    }
}
