import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { headlineDemoPage, prepareHeadlineDemo } from '../src/headline-demo.mjs';

const mode = process.argv[2];
if (process.argv.length !== 3 || !['--prepare', '--serve'].includes(mode)) {
  console.error('Usage: node apps/daemon/scripts/headline-demo.mjs --prepare|--serve');
  process.exitCode = 1;
} else {
  try {
    const fixture = prepareHeadlineDemo(join(tmpdir(), 'dylamo-approval-rehearsals'));
    console.log(`Disposable fixture (retained for inspection): ${fixture.directory}`);
    console.log(`CODEX_WORKSPACE for this demo: ${fixture.workspace}`);
    console.log(`GIT_CONFIG_GLOBAL for this demo: ${join(fixture.directory, 'empty-gitconfig')}`);
    console.log('Protected command: git push origin HEAD:refs/heads/phone-demo');
    console.log('The local phone-demo branch is empty. No push, phone call or Codex turn was made.');
    if (mode === '--serve') {
      const server = createServer((request, response) => {
        if (request.method !== 'GET' || request.url !== '/') {
          response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end('Not found');
          return;
        }
        try {
          const page = headlineDemoPage(fixture);
          response.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'",
          });
          response.end(page.html);
        } catch {
          response.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          response.end('The disposable fixture changed. Inspect it before continuing.');
        }
      });
      server.on('error', error => {
        console.error(`Preview could not start: ${error.code === 'EADDRINUSE'
          ? 'port 4173 is already in use' : 'localhost listener failed'}. The fixture remains on disk.`);
        process.exitCode = 1;
      });
      server.listen(4173, '127.0.0.1', () => {
        console.log('Local release preview: http://127.0.0.1:4173/');
        console.log('Keep this terminal open. The preview reads the local remote ref on every refresh.');
      });
    }
  } catch {
    console.error('FAIL: Could not prepare the disposable headline demo. Check Node and Git in your normal terminal.');
    process.exitCode = 1;
  }
}
