export * from "./interceptor-test-helpers";

import { Command } from "@/command";
import { Query } from "@/query";
import { Message } from "@hexaijs/core";

export class DummyCommand extends Command<null, void> {
    constructor() {
        super(null);
    }
}

export class DummyQuery extends Query<
    { id: string },
    { name: string }
> {
    constructor(id: string = "test-id") {
        super({ id });
    }
}

export class DummyEvent extends Message<null> {
    constructor() {
        super(null);
    }
}

export class TypedCommand extends Command<{ name: string }, { id: string }> {
    constructor(payload: { name: string }) {
        super(payload);
    }
}

export class TypedQuery extends Query<{ filter: string }, { items: string[] }> {
    constructor(payload: { filter: string }) {
        super(payload);
    }
}

export class VoidOutputCommand extends Command<{ data: string }, void> {
    constructor(payload: { data: string }) {
        super(payload);
    }
}
