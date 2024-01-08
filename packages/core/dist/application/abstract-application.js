"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AbstractApplication = void 0;
const lodash_1 = __importDefault(require("lodash"));
const inspections_1 = require("./inspections");
const error_response_1 = require("./error-response");
const error_1 = require("./error");
class AbstractApplication {
    context;
    executorRegistry;
    authFilters = new Map();
    authFactor = null;
    securityContext = null;
    errorObservers = [];
    constructor(context, executorRegistry) {
        this.context = context;
        this.executorRegistry = executorRegistry;
    }
    withSecurityContext(securityContext) {
        const newApp = this.clone();
        newApp.setSecurityContext(securityContext);
        return newApp;
    }
    setSecurityContext(securityContext) {
        this.securityContext = securityContext;
    }
    withAuthFactor(authFactor) {
        const newApp = this.clone();
        newApp.setAuthFactor(authFactor);
        return newApp;
    }
    setAuthFactor(authFactor) {
        this.authFactor = authFactor;
    }
    clone() {
        return lodash_1.default.clone(this);
    }
    withExecutor(key, executor, config) {
        this.executorRegistry.register(key, executor);
        if (config?.authFilter) {
            this.authFilters.set(executor, config.authFilter);
        }
        return this;
    }
    async execute(command) {
        const executor = this.executorRegistry.get(command);
        if (!executor) {
            return (0, error_response_1.validationErrorResponse)({
                "*": "UNSUPPORTED_MESSAGE_TYPE",
            });
        }
        try {
            await this.authenticate(command, executor);
        }
        catch (e) {
            if (e instanceof error_1.AuthError) {
                return (0, error_response_1.authErrorResponse)(e.message);
            }
        }
        this.injectApplicationContextTo(executor);
        return await this.doExecute(command, executor);
    }
    async authenticate(command, handler) {
        const authFilter = this.authFilters.get(handler);
        if (!authFilter) {
            return;
        }
        const authenticator = this.context.getAuthenticator?.();
        let securityContext;
        if (authenticator && this.authFactor) {
            securityContext = await authenticator(this.authFactor);
        }
        else {
            securityContext = this.securityContext;
        }
        if (!securityContext) {
            throw new error_1.AuthError("authentication failed or no authentication provided");
        }
        await authFilter(securityContext, command);
    }
    injectApplicationContextTo(handler) {
        if ((0, inspections_1.isApplicationContextAware)(handler)) {
            handler.setApplicationContext(this.context);
        }
    }
    async doExecute(command, executor) {
        try {
            return await this.context
                .getEventPublisher()
                .bindContext(this.makeEventContext(command), () => executor.execute(command));
        }
        catch (e) {
            const error = e;
            this.notifyErrorObservers(command, error);
            return (0, error_response_1.systemErrorResponse)(e.message);
        }
    }
    onError(observer) {
        this.errorObservers.push(observer);
    }
    notifyErrorObservers(command, error) {
        this.errorObservers.forEach((observer) => observer(command, error));
    }
}
exports.AbstractApplication = AbstractApplication;
//# sourceMappingURL=abstract-application.js.map