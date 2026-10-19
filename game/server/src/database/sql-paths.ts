import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function getRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../');
}

export function getMigrationsDir(): string {
  return path.join(getRepoRoot(), 'sql', 'migrations');
}
