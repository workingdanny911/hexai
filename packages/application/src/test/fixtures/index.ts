export * from "./interceptor-test-helpers";

import { Command } from "@/command";
import { Query } from "@/query";
import { Message } from "@hexaijs/core";

export class DummyCommand extends Command<null, { role: string }> {
    constructor(sc?: { role: string }) {
        super(null, sc);
    }
}

export class DummyQuery extends Query<{ id: string }, { role: string }> {
    constructor(id: string = "test-id", sc?: { role: string }) {
        super({ id }, {}, sc);
    }
}

export class DummyEvent extends Message<null> {
    constructor() {
        super(null);
    }
}
