import { ExpectStatic } from "vitest";
import * as process from "process";

export let expect!: ExpectStatic;

if (process.env.RUNNING_HEXAI_TESTS) {
    import("vitest").then(({ expect: expectStatic }) => {
        expect = expectStatic;
    });
}

export function setExpect(expectStatic: ExpectStatic) {
    expect = expectStatic;
}
