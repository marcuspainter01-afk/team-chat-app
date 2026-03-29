#!/usr/bin/env node
// Generates solid #4a9eff PNG icons for the PWA manifest
import { createWriteStream } from 'fs';
import { createDeflate } from 'zlib';
import { mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

function crc32(buf) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function uint32BE(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const crc = crc32(Buffer.concat([typeBytes, data]));
  return Buffer.concat([uint32BE(data.length), typeBytes, data, uint32BE(crc)]);
}

async function generatePng(size, filePath) {
  // PNG signature
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Raw pixel data: each row is filter byte (0) + RGB pixels
  const row = Buffer.alloc(1 + size * 3);
  row[0] = 0; // filter type None
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = 0x4a;   // R
    row[2 + x * 3] = 0x9e;   // G
    row[3 + x * 3] = 0xff;   // B
  }
  const rawData = Buffer.concat(Array(size).fill(row));

  // Compress with zlib deflate
  const compressed = await new Promise((resolve, reject) => {
    const deflate = createDeflate({ level: 6 });
    const chunks = [];
    deflate.on('data', c => chunks.push(c));
    deflate.on('end', () => resolve(Buffer.concat(chunks)));
    deflate.on('error', reject);
    deflate.write(rawData);
    deflate.end();
  });

  const idat = chunk('IDAT', compressed);
  const iend = chunk('IEND', Buffer.alloc(0));

  const png = Buffer.concat([sig, chunk('IHDR', ihdr), idat, iend]);
  await new Promise((resolve, reject) => {
    const ws = createWriteStream(filePath);
    ws.on('finish', resolve);
    ws.on('error', reject);
    ws.write(png);
    ws.end();
  });

  console.log(`Generated ${filePath} (${size}x${size})`);
}

await mkdir(publicDir, { recursive: true });
await generatePng(192, path.join(publicDir, 'icon-192.png'));
await generatePng(512, path.join(publicDir, 'icon-512.png'));
console.log('Icons generated.');
