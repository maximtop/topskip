import http from 'node:http';
import fs from 'node:fs';

const PORT = 9222;
const LOG_FILE = 'debug.log';

// Clear previous log
fs.writeFileSync(LOG_FILE, '');

const server = http.createServer(
    (req: http.IncomingMessage, res: http.ServerResponse) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        if (req.method === 'POST' && req.url === '/log') {
            let body = '';
            req.on('data', (chunk: Buffer) => {
                body += String(chunk);
            });
            req.on('end', () => {
                try {
                    const data: { source: string; message: string } =
                        JSON.parse(body) as {
                            source: string;
                            message: string;
                        };
                    const ts = new Date().toISOString();
                    const line = `[${ts}] [${data.source}] ${data.message}\n`;
                    fs.appendFileSync(LOG_FILE, line);
                    process.stdout.write(line);
                } catch {
                    const ts = new Date().toISOString();
                    const line = `[${ts}] [RAW] ${body}\n`;
                    fs.appendFileSync(LOG_FILE, line);
                    process.stdout.write(line);
                }
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                });
                res.end('{"ok":true}');
            });
            return;
        }

        res.writeHead(404);
        res.end('Not found');
    },
);

server.listen(PORT, '127.0.0.1', () => {
    console.log(`Log server listening on http://127.0.0.1:${String(PORT)}/log`);
    console.log(`Writing to ${LOG_FILE}`);
});
