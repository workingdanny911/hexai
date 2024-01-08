import { Class, List } from "ts-toolbelt";
export type Factory<R extends List.List = any[], T extends object = any> = Class.Class<R, T> | ((...args: R) => T);
//# sourceMappingURL=types.d.ts.map