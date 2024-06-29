import { ExpectStatic } from "vitest";

import { RUNNING_HEXAI_TEST } from "@/config";

export let expect!: ExpectStatic;

if (RUNNING_HEXAI_TEST) {
    import("vitest").then(({ expect: expectStatic }) => {
        expect = expectStatic;
    });
}

export function setExpect(expectStatic: any) {
    expect = expectStatic;
}
