// Reverse proxy minimal (HTTP + upgrade WebSocket) : reproduit la redirection de port
// de Codespaces, pour verifier que le jeu marche derriere un proxy.
import http from 'node:http';
import net from 'node:net';

const LISTEN = Number(process.argv[2] || 9090);
const TARGET = Number(process.argv[3] || 8080);

const server = http.createServer((req, res) => {
  const p = http.request(
    { host: '127.0.0.1', port: TARGET, path: req.url, method: req.method, headers: req.headers },
    (pr) => { res.writeHead(pr.statusCode, pr.headers); pr.pipe(res); },
  );
  p.on('error', () => { res.writeHead(502); res.end('proxy error'); });
  req.pipe(p);
});

// c'est ce passage qui casse chez beaucoup d'hebergeurs : l'upgrade WebSocket
server.on('upgrade', (req, socket, head) => {
  const up = net.connect(TARGET, '127.0.0.1', () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n`
      + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')
      + '\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(LISTEN, () => console.log(`proxy ${LISTEN} -> ${TARGET}`));
