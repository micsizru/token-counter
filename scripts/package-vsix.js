'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

/**
 * Recursively collects all .js files under a directory.
 * @param {string} dir
 * @param {string} [baseDir]
 * @returns {string[]} Posix-style relative paths from baseDir
 */
function collectSourceFiles(dir, baseDir = ROOT_DIR) {
  const results = [];
  if (!fs.existsSync(dir)) {
    return results;
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectSourceFiles(fullPath, baseDir));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(path.relative(baseDir, fullPath).replace(/\\/g, '/'));
    }
  }
  return results.sort();
}

const STATIC_EXTENSION_FILES = [
  'package.json',
  'README.md',
  'media/icon.svg',
  'media/logo.png',
  'media/help.md',
  'src/extension.js',
  'src/views.js',
  'src/proto.js',
  'src/tracker.js',
];

const EXTENSION_FILES = Array.from(
  new Set([...STATIC_EXTENSION_FILES, ...collectSourceFiles(path.join(ROOT_DIR, 'src'))])
);

const MIME_BY_EXT = {
  '.json': 'application/json',
  '.js': 'application/javascript',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.xml': 'text/xml',
  '.vsixmanifest': 'text/xml',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// Precompute IEEE 802.3 CRC32 table
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  return { dosDate, dosTime };
}

function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildContentTypesXml(entries) {
  const extMap = new Map();
  extMap.set('.vsixmanifest', 'text/xml');

  for (const entry of entries) {
    const ext = path.posix.extname(entry.zipPath).toLowerCase();
    if (ext && !extMap.has(ext)) {
      extMap.set(ext, MIME_BY_EXT[ext] || 'application/octet-stream');
    }
  }

  const defaults = Array.from(extMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([ext, contentType]) =>
        `  <Default Extension="${escapeXml(ext)}" ContentType="${escapeXml(contentType)}"/>`
    )
    .join('\n');

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    defaults,
    '</Types>',
    '',
  ].join('\n');
}

function buildVsixManifestXml(pkg) {
  const id = escapeXml(pkg.name);
  const version = escapeXml(pkg.version);
  const publisher = escapeXml(pkg.publisher || 'local');
  const displayName = escapeXml(pkg.displayName || pkg.name);
  const description = escapeXml(pkg.description || '');
  const engine = escapeXml((pkg.engines && pkg.engines.vscode) || '^1.80.0');
  const categories = escapeXml(
    Array.isArray(pkg.categories) && pkg.categories.length > 0 ? pkg.categories.join(',') : 'Other'
  );

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">',
    '  <Metadata>',
    `    <Identity Language="en-US" Id="${id}" Version="${version}" Publisher="${publisher}"/>`,
    `    <DisplayName>${displayName}</DisplayName>`,
    `    <Description xml:space="preserve">${description}</Description>`,
    `    <Categories>${categories}</Categories>`,
    '    <Icon>extension/media/logo.png</Icon>',
    '    <GalleryFlags>Public</GalleryFlags>',
    '    <Properties>',
    `      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${engine}"/>`,
    '      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/>',
    '      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/>',
    '      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui,workspace"/>',
    '    </Properties>',
    '  </Metadata>',
    '  <Installation>',
    '    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>',
    '  </Installation>',
    '  <Dependencies/>',
    '  <Assets>',
    '    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>',
    '    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>',
    '    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/media/logo.png" Addressable="true"/>',
    '  </Assets>',
    '</PackageManifest>',
    '',
  ].join('\n');
}

function createZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const zipPath = entry.zipPath.replace(/\\/g, '/');
    const nameBuf = Buffer.from(zipPath, 'utf8');
    const dataBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const compressedBuf = zlib.deflateRawSync(dataBuf, { level: 9 });
    const useStore = compressedBuf.length >= dataBuf.length;
    const payload = useStore ? dataBuf : compressedBuf;
    const method = useStore ? 0 : 8;
    const crc = crc32(dataBuf);
    const { dosDate, dosTime } = toDosDateTime(entry.mtime || new Date());

    // Local file header (30 bytes + filename)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed to extract (2.0)
    localHeader.writeUInt16LE(0x0800, 6); // general purpose bit flag (UTF-8)
    localHeader.writeUInt16LE(method, 8); // compression method
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(dataBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    localParts.push(localHeader, nameBuf, payload);

    // Central directory file header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed to extract
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(dataBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // file comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    centralHeader.writeUInt32LE(0, 38); // external file attributes
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header

    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + payload.length;
  }

  const centralDirSize = centralParts.reduce((sum, b) => sum + b.length, 0);
  const centralDirOffset = offset;

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // number of this disk
  eocd.writeUInt16LE(0, 6); // disk where central directory starts
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(centralDirOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function main() {
  const pkgPath = path.join(ROOT_DIR, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  const missing = [];
  const payloadEntries = [];

  for (const relPath of EXTENSION_FILES) {
    const absPath = path.join(ROOT_DIR, relPath);
    if (!fs.existsSync(absPath)) {
      missing.push(relPath);
      continue;
    }
    const stat = fs.statSync(absPath);
    const data = fs.readFileSync(absPath);
    payloadEntries.push({
      zipPath: `extension/${relPath.replace(/\\/g, '/')}`,
      data,
      mtime: stat.mtime,
    });
  }

  if (missing.length > 0) {
    console.error(`Paketleme hatası — eksik dosyalar:\n- ${missing.join('\n- ')}`);
    process.exit(1);
  }

  const now = new Date();
  const vsixManifestEntry = {
    zipPath: 'extension.vsixmanifest',
    data: Buffer.from(buildVsixManifestXml(pkg), 'utf8'),
    mtime: now,
  };

  const contentTypesEntry = {
    zipPath: '[Content_Types].xml',
    data: Buffer.from(buildContentTypesXml([vsixManifestEntry, ...payloadEntries]), 'utf8'),
    mtime: now,
  };

  const allEntries = [contentTypesEntry, vsixManifestEntry, ...payloadEntries];
  const zipBuffer = createZipBuffer(allEntries);

  fs.mkdirSync(DIST_DIR, { recursive: true });
  const vsixFileName = `${pkg.name}-${pkg.version}.vsix`;
  const outputPath = path.join(DIST_DIR, vsixFileName);
  fs.writeFileSync(outputPath, zipBuffer);

  console.log(`VSIX oluşturuldu: ${outputPath} (${(zipBuffer.length / 1024).toFixed(1)} KB)`);
  console.log(`Paketlenen dosyalar (${allEntries.length}):`);
  for (const entry of allEntries) {
    console.log(`  - ${entry.zipPath}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  createZipBuffer,
  buildContentTypesXml,
  buildVsixManifestXml,
  crc32,
  collectSourceFiles,
};
