import { expect, test } from "vitest";
import { Query } from "./query";

test("intent is 'query'", () => {
    expect(Query.getIntent()).toBe("query");
});
