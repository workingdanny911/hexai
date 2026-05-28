import { describe, expect, it } from "vitest";

import { ContextConfig } from "./context-config.js";
import { ConfigurationError } from "./errors.js";
import { ContractsPipeline } from "./pipeline.js";
import type { EntryStrategy } from "./domain/types.js";

describe("ContractsPipeline", () => {
    describe("entryStrategy validation", () => {
        it("should throw ConfigurationError for invalid programmatic entryStrategy", () => {
            expect(() =>
                ContractsPipeline.create({
                    contextConfig: ContextConfig.createSync(
                        "lecture",
                        "/tmp/lecture"
                    ),
                    entryStrategy: "file" as EntryStrategy,
                })
            ).toThrow(ConfigurationError);

            expect(() =>
                ContractsPipeline.create({
                    contextConfig: ContextConfig.createSync(
                        "lecture",
                        "/tmp/lecture"
                    ),
                    entryStrategy: "file" as EntryStrategy,
                })
            ).toThrow('Invalid entryStrategy: "file"');
        });
    });
});
