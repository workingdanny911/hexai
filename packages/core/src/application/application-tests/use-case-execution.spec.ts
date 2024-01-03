import { beforeEach, describe, expect, expectTypeOf, test } from "vitest";

import { expectAuthErrorResponse, expectSystemErrorResponse } from "@/test";
import {
    ApplicationBuilder,
    Authenticator,
    AuthFilter,
    ErrorResponse,
} from "@/application";
import {
    BarUseCase,
    BazUseCase,
    counterApplicationContext,
    FooUseCase,
    QuzUseCase,
} from "./application-tests.fixtures";

interface SecurityContext {
    userId: string;
}

describe("use case execution", () => {
    let builder: ApplicationBuilder;

    beforeEach(() => {
        builder = new ApplicationBuilder().withContext(
            counterApplicationContext
        );
    });

    test("with no use cases", async () => {
        const app = builder.build();

        const response = await app.execute(new FooUseCase.Request());

        expectSystemErrorResponse(response, /does not support/);
    });

    test("with a use case", async () => {
        await expect(
            builder
                .withUseCase(FooUseCase.Request, FooUseCase)
                .build()
                .execute(new FooUseCase.Request())
        ).resolves.toEqual(new FooUseCase.Response());
    });

    test("with multiple use cases", async () => {
        const app = builder
            .withUseCase(FooUseCase.Request, FooUseCase)
            .withUseCase(BarUseCase.Request, (ctx) => new BarUseCase(ctx))
            .withUseCase(BazUseCase.Request, BazUseCase)
            .withUseCase(QuzUseCase.Request, (ctx) => new QuzUseCase(ctx))
            .build();

        const fooResponse = await app.execute(new FooUseCase.Request());
        expectTypeOf(fooResponse).toEqualTypeOf<
            | {
                  Foo: "response";
              }
            | ErrorResponse
        >();
        expect(fooResponse).toEqual(new FooUseCase.Response());

        const barResponse = await app.execute(new BarUseCase.Request());
        expectTypeOf(barResponse).toEqualTypeOf<
            | {
                  Bar: "response";
              }
            | ErrorResponse
        >();
        expect(barResponse).toEqual(new BarUseCase.Response());

        const bazResponse = await app.execute(new BazUseCase.Request());
        expectTypeOf(bazResponse).toEqualTypeOf<
            | {
                  Baz: "response";
              }
            | ErrorResponse
        >();
        expect(bazResponse).toEqual(new BazUseCase.Response());

        const quzResponse = await app.execute(new QuzUseCase.Request());
        expectTypeOf(quzResponse).toEqualTypeOf<
            | {
                  Quz: "response";
              }
            | ErrorResponse
        >();
        expect(quzResponse).toEqual(new QuzUseCase.Response());
    });

    test("when auth filter is set but auth factor is not provided", async () => {
        const app = builder
            .withUseCase(FooUseCase.Request, FooUseCase, () =>
                Promise.resolve()
            )
            .build();

        const response = await app.execute(new FooUseCase.Request());

        expectAuthErrorResponse(
            response,
            "security context or auth factor must be provided."
        );
    });

    test("when security context is provided manually", async () => {
        const app = builder
            .withUseCase(FooUseCase.Request, FooUseCase, authFilterStub)
            .build();

        const response = await app
            .withSecurityContext({ userId: "anonymous-user-id" })
            .execute(new FooUseCase.Request());

        expectAuthErrorResponse(response, "auth validation failed");

        await expect(
            app
                .withSecurityContext({ userId: "authenticated-user-id" })
                .execute(new FooUseCase.Request())
        ).resolves.toEqual(new FooUseCase.Response());
    });

    test("when trying to provide auth factor but authenticator is not set", async () => {
        const app = builder.withUseCase(FooUseCase.Request, FooUseCase).build();

        expect(() => {
            app.withAuthFactor("auth-factor").execute(new FooUseCase.Request());
        }).toThrowError(/.*authenticator must be provided.*/);
    });

    test("auth by factor", async () => {
        const app = builder
            .withAuthenticator(authenticatorStub)
            .withUseCase(FooUseCase.Request, FooUseCase, authFilterStub)
            .build();

        const response = await app
            .withAuthFactor("invalid-auth-factor")
            .execute(new FooUseCase.Request());

        expectAuthErrorResponse(response, "auth validation failed");

        await expect(
            app
                .withAuthFactor("valid-auth-factor")
                .execute(new FooUseCase.Request())
        ).resolves.toEqual(new FooUseCase.Response());
    });
});

const authFilterStub: AuthFilter<SecurityContext> = async (securityContext) => {
    if (securityContext.userId !== "authenticated-user-id") {
        throw new Error("auth validation failed");
    }
};

const authenticatorStub: Authenticator<string, SecurityContext> = async (
    factor
) => {
    if (factor !== "valid-auth-factor") {
        return {
            userId: "anonymous-user-id",
        };
    }

    return {
        userId: "authenticated-user-id",
    };
};
