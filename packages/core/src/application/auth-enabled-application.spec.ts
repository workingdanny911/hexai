import { beforeEach, describe, expect, test, vi } from "vitest";

import { UnitOfWork } from "@/infra";
import { expectAuthErrorResponse } from "@/test";
import { ApplicationEventPublisher } from "./application-event-publisher";
import { CommandExecutor } from "./command-executor";
import { CommandExecutorRegistry } from "./command-executor-registry";
import { Authenticator, AuthFilter } from "./auth";
import { AuthError } from "./error";
import {
    AuthEnabledApplication,
    AuthEnabledApplicationContext,
} from "./auth-enabled-application";
import { CommandExecutorRegistryForTest } from "./test-fixtures";

interface SecurityContextForTest {
    userId?: string;
}

interface ApplicationContextForTest
    extends AuthEnabledApplicationContext<
        UnitOfWork,
        ApplicationEventPublisher,
        Authenticator<string, SecurityContextForTest>
    > {}

class ApplicationForTest extends AuthEnabledApplication<
    ApplicationContextForTest,
    object,
    SecurityContextForTest
> {
    constructor(
        context: ApplicationContextForTest,
        handlers: CommandExecutorRegistry<
            string,
            object
        > = new CommandExecutorRegistryForTest()
    ) {
        super(context, handlers);
    }

    protected makeEventPublishingContext(command: object): object {
        return {};
    }
}

describe("Application", () => {
    let defaultApp: ApplicationForTest;
    let eventPublisher: ApplicationEventPublisher;
    let applicationContext: ApplicationContextForTest;
    const authenticator: Authenticator<string, SecurityContextForTest> = (
        factor
    ) => {
        if (factor === "valid") {
            return {
                userId: "user-id",
            };
        }

        throw new AuthError("invalid factor");
    };
    const authFilter: AuthFilter<SecurityContextForTest, any> = (
        ctx,
        message
    ) => {
        if (!ctx.userId) {
            throw new Error("unauthenticated");
        }
    };
    const handler: CommandExecutor<any, any> = {
        execute: vi.fn(),
    };

    function makeApp() {
        return new ApplicationForTest(applicationContext);
    }

    beforeEach(() => {
        eventPublisher = new ApplicationEventPublisher();
        applicationContext = {
            getEventPublisher: () => eventPublisher,
            getUnitOfWork: vi.fn(),
            getAuthenticator: () => authenticator,
        };
        defaultApp = makeApp();

        vi.resetAllMocks();
        vi.resetAllMocks();
    });

    beforeEach(() => {
        defaultApp.withExecutor("auth-only", handler, { authFilter });
    });

    test("applying auth filter, but with no security context or auth factor", async () => {
        const response = await defaultApp.execute({ type: "auth-only" });

        expectAuthErrorResponse(response, /.*no authentication.*/);
    });

    test("applying auth filter with security context", async () => {
        const response = await defaultApp
            .withSecurityContext({
                userId: "authenticated-user-id",
            })
            .execute({ type: "auth-only" });

        expect(response).toBeUndefined();
        expect(handler.execute).toHaveBeenCalled();
    });

    test("applying auth filter with auth factor", async () => {
        const response = await defaultApp
            .withAuthFactor("valid")
            .execute({ type: "auth-only" });

        expect(response).toBeUndefined();
        expect(handler.execute).toHaveBeenCalled();
    });
});
