import http from 'node:http';

export function createManagementServer(client) {
  return http.createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/health') {
      response.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      response.end('not found');
      return;
    }
    const body = JSON.stringify(client.status());
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    response.end(body);
  });
}
