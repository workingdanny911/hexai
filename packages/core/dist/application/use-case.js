"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UseCase = void 0;
const domain_1 = require("../domain");
const error_response_1 = require("./error-response");
class UseCase {
    applicationContext;
    eventPublisher;
    setApplicationContext(applicationContext) {
        this.applicationContext = applicationContext;
        this.eventPublisher = applicationContext.getEventPublisher();
    }
    async execute(command) {
        try {
            return await this.doExecute(command);
        }
        catch (e) {
            return this.constructor.mapErrorToResponse(e);
        }
    }
    getUnitOfWork() {
        return this.applicationContext.getUnitOfWork();
    }
    static mapErrorToResponse(error) {
        return (this.errorToResponse(error) ?? this.defaultErrorToResponse(error));
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    static errorToResponse(error) {
        return;
    }
    static defaultErrorToResponse(error) {
        if (error instanceof domain_1.ValidationError) {
            return (0, error_response_1.validationErrorResponse)({
                [error.field]: [error.code, error.message],
            });
        }
        return (0, error_response_1.unknownErrorResponse)(error.message);
    }
}
exports.UseCase = UseCase;
//# sourceMappingURL=use-case.js.map