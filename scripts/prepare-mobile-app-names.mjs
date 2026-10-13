import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

export function prepareAndroidAppNames(root = projectRoot) {
  const sourceRoot = path.join(root, 'src-tauri', 'mobile', 'android');
  const generatedResources = path.join(
    root, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res',
  );

  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('values')) continue;
    const destinationDir = path.join(generatedResources, entry.name);
    mkdirSync(destinationDir, { recursive: true });
    copyFileSync(
      path.join(sourceRoot, entry.name, 'strings.xml'),
      path.join(destinationDir, 'strings.xml'),
    );
  }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const platform = process.argv[2];
  if (platform === 'android') {
    prepareAndroidAppNames();
    console.log('[app-names] Added Android default and Chinese app names');
  } else {
    console.error('Usage: node scripts/prepare-mobile-app-names.mjs android');
    process.exitCode = 1;
  }
}
