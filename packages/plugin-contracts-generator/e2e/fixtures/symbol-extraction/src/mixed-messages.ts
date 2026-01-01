/**
 * Fixture for symbol extraction tests
 *
 * This file contains:
 * - @PublicEvent with its dependencies
 * - @PublicCommand with its dependencies
 * - Handler class with its dependencies
 *
 * Expected behavior:
 * - `-m event`: Extract only UserRegistered + UserRegisteredPayload
 * - `-m command`: Extract only RegisterUser + RegisterUserPayload + RegisterUserResponse
 * - Both should exclude Handler and Handler-only imports
 */

import { DomainEvent, Message } from "@hexaijs/core";
import {
    PublicEvent,
    PublicCommand,
} from "@hexaijs/plugin-contracts-generator/decorators";

// Handler-only imports (should be excluded when extracting messages)
import { CommandHandlerMarker } from "@hexaijs/plugin-application-builder";
import { BaseUseCase, SecurityContextHelper } from "@student-planner/common";
import { UserRepository } from "./repository";

// ===== Event and its dependencies =====

export interface UserRegisteredPayload {
    userId: string;
    email: string;
    registeredAt: Date;
}

@PublicEvent()
export class UserRegistered extends DomainEvent<UserRegisteredPayload> {
    public static type = "user.registered";
}

// ===== Command and its dependencies =====

export interface RegisterUserPayload {
    email: string;
    password: string;
    name: string;
}

@PublicCommand()
export class RegisterUser extends Message<RegisterUserPayload> {
    public static type = "user.register";
}

export interface RegisterUserResponse {
    userId: string;
    createdAt: Date;
}

// ===== Handler (should be excluded) =====

@CommandHandlerMarker(RegisterUser)
export class RegisterUserHandler extends BaseUseCase<
    RegisterUser,
    RegisterUserResponse
> {
    constructor(private readonly userRepository: UserRepository) {
        super();
    }

    protected async doExecute(
        request: RegisterUser
    ): Promise<RegisterUserResponse> {
        const sc = request.getSecurityContext();

        if (!SecurityContextHelper.isAnonymous(sc)) {
            throw new Error("Already authenticated");
        }

        const user = await this.userRepository.create({
            email: request.payload.email,
            password: request.payload.password,
            name: request.payload.name,
        });

        return {
            userId: user.id,
            createdAt: user.createdAt,
        };
    }
}

// ===== Unrelated symbols (should be excluded) =====

export interface SomeUnrelatedType {
    foo: string;
}

export function someUnrelatedFunction(): void {
    console.log("unrelated");
}
