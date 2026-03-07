import { expect, test } from "vitest";
import { Query } from "./query.js";

test("intent is 'query'", () => {
    expect(Query.getIntent()).toBe("query");
});
