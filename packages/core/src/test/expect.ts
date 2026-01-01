import { RUNNING_HEXAI_TEST } from "@/config";

export let expect!: any;

// if (RUNNING_HEXAI_TEST) {
//     import("vitest").then(({ expect: expectStatic }) => {
//         expect = expectStatic;
//     });
// }

export function setExpect(expectStatic: any) {
    expect = expectStatic;
}
