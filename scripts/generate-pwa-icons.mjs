import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const outputDirectory = new URL('../public/icons/', import.meta.url);
const colors = {
  background: [23, 37, 84, 255],
  runner: [255, 255, 255, 255],
  accent: [211, 214, 107, 255],
  coral: [245, 87, 108, 255],
};

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const checksumInput = Buffer.concat([typeBytes, data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(checksumInput));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function segmentDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const amount = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + amount * dx), py - (y1 + amount * dy));
}

function coverage(distance, radius) {
  return Math.max(0, Math.min(1, radius + 0.75 - distance));
}

function blend(background, foreground, amount) {
  const alpha = amount * (foreground[3] / 255);
  return [0, 1, 2].map((index) => Math.round(background[index] * (1 - alpha) + foreground[index] * alpha));
}

function drawPixel(x, y) {
  let color = colors.background.slice(0, 3);
  const shapes = [
    { distance: Math.abs(Math.hypot(x - 0.5, y - 0.5) - 0.405), radius: 0.018, color: colors.accent },
    { distance: Math.hypot(x - 0.53, y - 0.255), radius: 0.066, color: colors.accent },
    { distance: segmentDistance(x, y, 0.51, 0.34, 0.46, 0.56), radius: 0.047, color: colors.runner },
    { distance: segmentDistance(x, y, 0.48, 0.42, 0.31, 0.49), radius: 0.034, color: colors.runner },
    { distance: segmentDistance(x, y, 0.48, 0.42, 0.68, 0.365), radius: 0.034, color: colors.runner },
    { distance: segmentDistance(x, y, 0.46, 0.56, 0.29, 0.75), radius: 0.039, color: colors.runner },
    { distance: segmentDistance(x, y, 0.46, 0.56, 0.69, 0.675), radius: 0.039, color: colors.coral },
    { distance: segmentDistance(x, y, 0.31, 0.49, 0.27, 0.43), radius: 0.026, color: colors.runner },
    { distance: segmentDistance(x, y, 0.68, 0.365, 0.75, 0.41), radius: 0.026, color: colors.runner },
  ];
  for (const shape of shapes) color = blend(color, shape.color, coverage(shape.distance, shape.radius));
  return [...color, 255];
}

function png(size) {
  const scanlines = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    scanlines[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const color = drawPixel((x + 0.5) / size, (y + 0.5) / size);
      const pixel = row + 1 + x * 4;
      for (let channel = 0; channel < 4; channel += 1) scanlines[pixel + channel] = color[channel];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

await mkdir(outputDirectory, { recursive: true });
for (const size of [192, 512]) {
  await writeFile(new URL(`run-together-${size}.png`, outputDirectory), png(size));
}
