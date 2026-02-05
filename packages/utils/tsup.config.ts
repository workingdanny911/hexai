import { defineConfig } from 'tsup';
import { createTsupConfig } from '../tooling/tsup.base';

export default defineConfig(
  createTsupConfig({
    entry: {
      'config/index': 'src/config/index.ts',
    },
    tsconfig: 'tsconfig.build.json',
  })
);
