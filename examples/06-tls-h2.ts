// TLS и HTTP/2 (§12). ALPN сам согласует h2 или http/1.1 — отдельного порта
// под каждый протокол не нужно.
import { readFileSync } from 'node:fs';

import { Server } from '../js/index.ts';

// TLS-порт: клиенты с поддержкой h2 получат h2, остальные — http/1.1.
const tls = new Server({
  tls: {
    // Принимается PEM-строка, путь к файлу или Buffer.
    cert: readFileSync('__test__/fixtures/cert.pem', 'utf8'),
    key: readFileSync('__test__/fixtures/key.pem', 'utf8'),
  },
  http2: {
    maxConcurrentStreams: 250,
    initialWindowSize: '1mb',
    // Защита от Rapid Reset (CVE-2023-44487).
    maxResetStreamsPerSec: 100,
  },
  // Slowloris: медленные заголовки и тела обрываются в Rust.
  headerReadTimeout: '10s',
  bodyReadTimeout: '30s',
  idleTimeout: '75s',
});

tls.get('/', (c) => c.json({ secure: true }));
await tls.listen({ port: 8443 });

// Plaintext-порт с h2c prior-knowledge: за TLS-терминирующим прокси внутри
// кластера шифровать второй раз незачем, а мультиплекс h2 сохранить хочется.
const plain = new Server({ h2c: true });
plain.get('/', (c) => c.json({ h2c: true }));
await plain.listen({ port: 8080 });

console.log('https://127.0.0.1:8443  (h2 / http1.1 по ALPN)');
console.log('http://127.0.0.1:8080   (h2c prior-knowledge + http1.1)');
