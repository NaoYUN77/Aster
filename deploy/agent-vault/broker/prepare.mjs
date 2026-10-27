import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

// No branch/tag resolution and no downloaded executables are run in this stage.
const archives = [
  {
    url: 'https://codeload.github.com/Infisical/agent-vault/tar.gz/872578e4cdf9e03d5e3bcb5512023a70bf90ed65',
    sha256: 'eca97d0ba4541c708e9d1b9ecee9bcf988f4b1f8e652cb40a0ae11c89ec8ee48',
    dest: '/reviewed',
    select: name => ['main.go', 'go.mod', 'go.sum', 'LICENSE'].includes(name) || /^(cmd|internal|web)\//.test(name),
  },
  {
    url: 'https://codeload.github.com/Infisical/go-sdk/tar.gz/4ed5667bdf11d36643da4fd9cd05c660e30e24dd',
    sha256: '1760090d14f57e46ad65e533e57d8351bee49ea75596846f24d059ffab0123ae',
    dest: '/reviewed/third_party/infisical-go-sdk',
    select: name => (!name.includes('/') && /\.(go|mod|sum)$/.test(name)) || name === 'LICENSE' || /^packages\//.test(name),
  },
];

function text(bytes) {
  return bytes.toString('utf8').split('\0')[0];
}

for (const archive of archives) {
  const response = await fetch(archive.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error('pinned source download failed');
  const compressed = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(compressed).digest('hex') !== archive.sha256) throw new Error('pinned source checksum mismatch');
  const tar = gunzipSync(compressed, { maxOutputLength: 256 * 1024 * 1024 });
  const written = new Set();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = [text(header.subarray(345, 500)), text(header.subarray(0, 100))].filter(Boolean).join('/').split('/').slice(1).join('/');
    const size = Number.parseInt(text(header.subarray(124, 136)).trim(), 8);
    const type = text(header.subarray(156, 157));
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('invalid pinned archive');
    offset += 512;
    if (archive.select(name)) {
      if (name.startsWith('/') || name.includes('\\') || name.split('/').some(part => part === '..')) throw new Error('unsafe archive path');
      if (type !== '5') {
        if (type !== '' && type !== '0') throw new Error('archive links and special files are forbidden');
        if (written.has(name)) throw new Error('duplicate archive member');
        written.add(name);
        const path = join(archive.dest, name);
        await mkdir(join(path, '..'), { recursive: true });
        await writeFile(path, tar.subarray(offset, offset + size), { flag: 'wx', mode: 0o644 });
      }
    }
    offset += Math.ceil(size / 512) * 512;
  }
}
