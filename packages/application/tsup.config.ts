import { defineConfig } from 'tsup';
import { createTsupConfig } from '../tooling/tsup.base';

export default defineConfig(
  createTsupConfig({
    entry: {
      index: 'src/index.ts',
      'pino/index': 'src/pino/index.ts',
    },
    tsconfig: 'tsconfig.build.json',
  })
);
