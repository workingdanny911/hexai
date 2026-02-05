import { defineConfig } from 'tsup';
import { createTsupConfig } from '../tooling/tsup.base';

export default defineConfig(
  createTsupConfig({
    entry: {
      index: 'src/index.ts',
      request: 'src/request.ts',
    },
    tsconfig: 'tsconfig.build.json',
  })
);
