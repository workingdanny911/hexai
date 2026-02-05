import { defineConfig } from 'tsup';
import { createTsupConfig } from '../tooling/tsup.base';

export default defineConfig(
  createTsupConfig({
    entry: {
      index: 'src/index.ts',
      'decorators/index': 'src/decorators/index.ts',
      'runtime/index': 'src/runtime/index.ts',
      cli: 'src/cli.ts',
    },
    tsconfig: 'tsconfig.build.json',
  })
);
