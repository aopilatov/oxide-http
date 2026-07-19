// TLS and HTTP/2 (§12). ALPN negotiates h2 or http/1.1 on its own — no separate port
// per protocol is needed.
import { readFileSync } from 'node:fs';

import { Server } from '../js/index.ts';

// TLS port: clients that support h2 get h2, the rest get http/1.1.
const tls = new Server({
  tls: {
    // Accepts a PEM string, a file path, or a Buffer.
    cert: readFileSync('__test__/fixtures/cert.pem', 'utf8'),
    key: readFileSync('__test__/fixtures/key.pem', 'utf8'),
  },
  http2: {
    maxConcurrentStreams: 250,
    initialWindowSize: '1mb',
    // Rapid Reset protection (CVE-2023-44487).
    maxResetStreamsPerSec: 100,
  },
  // Slowloris: slow headers and bodies are cut off in Rust.
  headerReadTimeout: '10s',
  bodyReadTimeout: '30s',
  idleTimeout: '75s',
});

tls.get('/', (c) => c.json({ secure: true }));
await tls.listen({ port: 8443 });

// Plaintext port with h2c prior-knowledge: behind a TLS-terminating proxy inside the
// cluster there is no point encrypting twice, but h2 multiplexing is worth keeping.
const plain = new Server({ h2c: true });
plain.get('/', (c) => c.json({ h2c: true }));
await plain.listen({ port: 8080 });

console.log('https://127.0.0.1:8443  (h2 / http1.1 via ALPN)');
console.log('http://127.0.0.1:8080   (h2c prior-knowledge + http1.1)');
