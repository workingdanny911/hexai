import type { Options } from 'tsup';

export function createTsupConfig(options: Partial<Options> = {}): Options {
  return {
    format: ['esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
    ...options,
  };
}
