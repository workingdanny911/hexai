/**
 * Repository - Handler-only dependency
 *
 * This file should NOT be copied when extracting Event or Command,
 * because only Handler uses it.
 */

export interface User {
    id: string;
    email: string;
    name: string;
    createdAt: Date;
}

export interface CreateUserInput {
    email: string;
    password: string;
    name: string;
}

export interface UserRepository {
    create(input: CreateUserInput): Promise<User>;
    findById(id: string): Promise<User | null>;
    findByEmail(email: string): Promise<User | null>;
}
