import { defineConfig } from 'tsup';
import { createTsupConfig } from '../tooling/tsup.base';

export default defineConfig(
  createTsupConfig({
    entry: {
      index: 'src/index.ts',
      test: 'src/test.ts',
    },
    tsconfig: 'tsconfig.build.json',
  })
);
