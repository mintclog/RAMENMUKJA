import { mkdir, readdir, copyFile } from 'node:fs/promises';

// Copy only public application assets; docs, SQL, credentials and server code stay private.
await mkdir('dist/src', { recursive: true });
await copyFile('index.html', 'dist/index.html');
for (const name of await readdir('src')) {
  if (/^[a-z0-9-]+\.(?:js|css|svg)$/.test(name)) await copyFile('src/' + name, 'dist/src/' + name);
}
console.log('Static application copied to dist.');
