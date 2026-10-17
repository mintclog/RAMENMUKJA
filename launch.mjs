import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT || 4173);
const url = `http://127.0.0.1:${port}`;
const cwd = fileURLToPath(new URL('.', import.meta.url));

function isReady() {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode === 200 && body.includes('<title>라멘묵자 — 취향으로 찾는 한 그릇</title>')) resolve(true);
        else reject(new Error(`Port ${port} is used by another service. Close it or choose another PORT.`));
      });
    });
    request.setTimeout(1500, () => request.destroy(new Error('The local server did not respond.')));
    request.on('error', error => error.code === 'ECONNREFUSED' ? resolve(false) : reject(error));
  });
}

function openBrowser() {
  return new Promise((resolve, reject) => {
    const opener = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, stdio: 'ignore' });
    opener.on('error', reject);
    opener.on('exit', code => code === 0 ? resolve() : reject(new Error(`Could not open the browser. Open ${url} manually.`)));
  });
}

let server;
try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or later is required.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
  if (await isReady()) {
    console.log(`Server is already running: ${url}`);
    await openBrowser();
  } else {
    console.log('Starting Ramenmukja. Keep this window open; press Ctrl+C to stop.');
    server = spawn(process.execPath, ['server.mjs'], { cwd, stdio: 'inherit' });
    let serverError;
    server.on('error', error => { serverError = error; });
    server.on('exit', code => { process.exitCode = code ?? 0; });
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (serverError) throw serverError;
      if (server.exitCode !== null) throw new Error('The server could not start. See the error above.');
      if (await isReady()) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error('Server startup timed out.');
    try {
      await openBrowser();
    } catch (error) {
      console.error(`${error.message}\nThe server is running. Open ${url} manually.`);
    }
  }
} catch (error) {
  console.error(error.message);
  server?.kill();
  process.exitCode = 1;
}
