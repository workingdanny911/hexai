import { ExpectStatic } from "vitest";

export let expect!: ExpectStatic;

import("vitest").then(({ expect: expectStatic }) => {
    expect = expectStatic;
});

export function setExpect(expectStatic: ExpectStatic) {
    expect = expectStatic;
}
