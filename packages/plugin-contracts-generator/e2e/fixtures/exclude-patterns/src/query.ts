// Entry point file - has @PublicCommand decorator (simulated)
// This file imports from various files including those that should be excluded

import { ReadModelManager } from "./read-model-manager.eh";
import { DbConnection } from "./db";
import { InfraService } from "./infra/service";
import { TestHelper } from "./test-helper.test";
import { SpecHelper } from "./spec-helper.spec";
import { SomeType } from "./types";

export class MyQuery {
    // Query implementation
}

export { SomeType };
