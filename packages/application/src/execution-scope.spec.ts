import { describe, expect, test } from "vitest";

import type { MessageTrace } from "@hexaijs/core";
import { ExecutionScope } from "./execution-scope";

describe("ExecutionScope", () => {
    describeFieldBehavior({
        fieldName: "securityContext",
        getter: () => ExecutionScope.getSecurityContext(),
        parentValue: { id: "user-1", role: "admin" },
        childValue: { id: "user-2", role: "user" },
    });

    describeFieldBehavior({
        fieldName: "correlation",
        getter: () => ExecutionScope.getCorrelation(),
        parentValue: { id: "msg-1", type: "TestCommand" } as MessageTrace,
        childValue: { id: "msg-2", type: "ChildCommand" } as MessageTrace,
    });

    describeFieldBehavior({
        fieldName: "causation",
        getter: () => ExecutionScope.getCausation(),
        parentValue: { id: "cmd-1", type: "CreateOrder" } as MessageTrace,
        childValue: { id: "evt-1", type: "OrderCreated" } as MessageTrace,
    });

    test("child scope can explicitly clear securityContext with undefined", async () => {
        const user = { id: "user-1" };

        await ExecutionScope.run({ securityContext: user }, async () => {
            await ExecutionScope.run({ securityContext: undefined }, async () => {
                expect(ExecutionScope.getSecurityContext()).toBeUndefined();
            });
        });
    });

    describe("requireSecurityContext", () => {
        test("returns security context when present", async () => {
            const user = { id: "user-1" };

            await ExecutionScope.run({ securityContext: user }, async () => {
                expect(ExecutionScope.requireSecurityContext()).toBe(user);
            });
        });

        test("throws when no security context in scope", async () => {
            await ExecutionScope.run({}, async () => {
                expect(() => ExecutionScope.requireSecurityContext()).toThrow(
                    "No security context in current execution scope",
                );
            });
        });

        test("throws outside scope", () => {
            expect(() => ExecutionScope.requireSecurityContext()).toThrow(
                "No security context in current execution scope",
            );
        });
    });

    describe("snapshot / restore", () => {
        test("captures all fields", async () => {
            const user = { id: "user-1" };
            const correlation: MessageTrace = { id: "msg-1", type: "Cmd" };
            const causation: MessageTrace = { id: "cmd-1", type: "Root" };

            await ExecutionScope.run(
                { securityContext: user, correlation, causation },
                async () => {
                    const snap = ExecutionScope.snapshot()!;

                    expect(snap.securityContext).toBe(user);
                    expect(snap.correlation).toEqual(correlation);
                    expect(snap.causation).toEqual(causation);
                },
            );
        });

        test("returns undefined when no scope", () => {
            expect(ExecutionScope.snapshot()).toBeUndefined();
        });

        test("restores scope in a different async context", async () => {
            const user = { id: "user-1" };
            const correlation: MessageTrace = { id: "msg-1", type: "Cmd" };
            const causation: MessageTrace = { id: "cmd-1", type: "Root" };

            const captured = await ExecutionScope.run(
                { securityContext: user, correlation, causation },
                async () => ExecutionScope.snapshot(),
            );

            expect(ExecutionScope.getSecurityContext()).toBeUndefined();

            await ExecutionScope.restore(captured!, async () => {
                expect(ExecutionScope.getSecurityContext()).toBe(user);
                expect(ExecutionScope.getCorrelation()).toEqual(correlation);
                expect(ExecutionScope.getCausation()).toEqual(causation);
            });
        });

        test("snapshot is frozen", async () => {
            await ExecutionScope.run({ securityContext: "user" }, async () => {
                const snap = ExecutionScope.snapshot()!;
                expect(() => {
                    (snap as any).securityContext = "tampered";
                }).toThrow();
            });
        });

        test("restore creates independent store", async () => {
            const user = { id: "user-1" };

            const captured = await ExecutionScope.run(
                { securityContext: user },
                async () => ExecutionScope.snapshot(),
            );

            await ExecutionScope.restore(captured!, async () => {
                await ExecutionScope.run({ securityContext: { id: "user-2" } }, async () => {
                    expect(ExecutionScope.getSecurityContext()).toEqual({ id: "user-2" });
                });
                expect(ExecutionScope.getSecurityContext()).toBe(user);
            });
        });
    });

    test("parallel scopes do not interfere", async () => {
        const results: unknown[] = [];

        await Promise.all([
            ExecutionScope.run({ securityContext: "alice" }, async () => {
                await delay(10);
                results.push(ExecutionScope.getSecurityContext());
            }),
            ExecutionScope.run({ securityContext: "bob" }, async () => {
                await delay(5);
                results.push(ExecutionScope.getSecurityContext());
            }),
        ]);

        expect(results).toContain("alice");
        expect(results).toContain("bob");
    });

    describe("sync callback", () => {
        test("provides value within scope", () => {
            const user = { id: "user-1" };

            ExecutionScope.run({ securityContext: user }, () => {
                expect(ExecutionScope.getSecurityContext()).toBe(user);
            });
        });

        test("returns sync value", () => {
            const result = ExecutionScope.run({ securityContext: "alice" }, () => 42);

            expect(result).toBe(42);
        });

        test("child scope inherits parent value", () => {
            const user = { id: "user-1" };

            ExecutionScope.run({ securityContext: user }, () => {
                ExecutionScope.run({}, () => {
                    expect(ExecutionScope.getSecurityContext()).toBe(user);
                });
            });
        });

        test("nested async scope inherits from sync parent", async () => {
            const user = { id: "user-1" };

            ExecutionScope.run({ securityContext: user }, () => {
                setTimeout(async () => {
                    expect(ExecutionScope.getSecurityContext()).toBe(user);
                }, 0);
            });

            await new Promise((r) => setTimeout(r, 10));
        });
    });

    describe("sync restore", () => {
        test("restores scope synchronously", async () => {
            const user = { id: "user-1" };
            const correlation: MessageTrace = { id: "msg-1", type: "Cmd" };

            const captured = await ExecutionScope.run(
                { securityContext: user, correlation },
                async () => ExecutionScope.snapshot(),
            );

            expect(ExecutionScope.getSecurityContext()).toBeUndefined();

            ExecutionScope.restore(captured!, () => {
                expect(ExecutionScope.getSecurityContext()).toBe(user);
                expect(ExecutionScope.getCorrelation()).toEqual(correlation);
            });
        });

        test("returns sync value", async () => {
            const captured = await ExecutionScope.run(
                { securityContext: "alice" },
                async () => ExecutionScope.snapshot(),
            );

            const result = ExecutionScope.restore(captured!, () => 99);

            expect(result).toBe(99);
        });
    });

    test("overriding one field does not affect others", async () => {
        const user = { id: "user-1" };
        const correlation: MessageTrace = { id: "msg-1", type: "Cmd" };
        const causation: MessageTrace = { id: "cmd-1", type: "Root" };
        const childCausation: MessageTrace = { id: "evt-1", type: "Event" };

        await ExecutionScope.run(
            { securityContext: user, correlation, causation },
            async () => {
                await ExecutionScope.run({ causation: childCausation }, async () => {
                    expect(ExecutionScope.getSecurityContext()).toBe(user);
                    expect(ExecutionScope.getCorrelation()).toEqual(correlation);
                    expect(ExecutionScope.getCausation()).toEqual(childCausation);
                });
            },
        );
    });
});

function describeFieldBehavior({
    fieldName,
    getter,
    parentValue,
    childValue,
}: {
    fieldName: string;
    getter: () => unknown;
    parentValue: unknown;
    childValue: unknown;
}) {
    const scopeWith = (value: unknown) =>
        ({ [fieldName]: value }) as Parameters<typeof ExecutionScope.run>[0];

    describe(fieldName, () => {
        test("provides value within scope", async () => {
            await ExecutionScope.run(scopeWith(parentValue), async () => {
                expect(getter()).toBe(parentValue);
            });
        });

        test("returns undefined outside scope", () => {
            expect(getter()).toBeUndefined();
        });

        test("child scope inherits parent value", async () => {
            await ExecutionScope.run(scopeWith(parentValue), async () => {
                await ExecutionScope.run({}, async () => {
                    expect(getter()).toBe(parentValue);
                });
            });
        });

        test("child scope overrides parent value", async () => {
            await ExecutionScope.run(scopeWith(parentValue), async () => {
                await ExecutionScope.run(scopeWith(childValue), async () => {
                    expect(getter()).toBe(childValue);
                });
                expect(getter()).toBe(parentValue);
            });
        });
    });
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
