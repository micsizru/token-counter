'use strict';

/**
 * @fileoverview Cross-platform VSIX uninstaller for Token Sayar (Windows, macOS, Linux).
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TARGETS = [
  { name: 'Antigravity IDE (2.x)', cli: 'antigravity-ide' },
  { name: 'Visual Studio Code', cli: 'code' },
  { name: 'Antigravity (1.x)', cli: 'antigravity' },
];

function parseArgs(argv) {
  let targetCli = null;

  for (const arg of argv) {
    if (arg.startsWith('--target=')) {
      targetCli = arg.slice('--target='.length).trim();
    }
  }

  return { targetCli };
}

function isCliAvailable(cli) {
  const result = spawnSync(cli, ['--version'], {
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  return result.status === 0 && !result.error;
}

function main() {
  const { targetCli } = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(__dirname, '..');

  const pkgPath = path.join(rootDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const extId = `${pkg.publisher}.${pkg.name}`;

  let selectedTargets = TARGETS;
  if (targetCli) {
    selectedTargets = TARGETS.filter((t) => t.cli === targetCli);
    if (selectedTargets.length === 0) {
      selectedTargets = [{ name: targetCli, cli: targetCli }];
    }
  }

  const availableTargets = selectedTargets.filter((t) => isCliAvailable(t.cli));
  if (availableTargets.length === 0) {
    console.log('Hicbir desteklenen IDE CLI araci (antigravity-ide, code, antigravity) PATH uzerinde bulunamadi.');
    return;
  }

  for (const target of availableTargets) {
    console.log(`[${target.name}] Kaldiriliyor: ${extId} (${target.cli})...`);
    const res = spawnSync(target.cli, ['--uninstall-extension', extId], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    if (res.status === 0) {
      console.log(`[${target.name}] Kaldirma tamamlandi.`);
    } else {
      console.log(`[${target.name}] Kaldirma tamamlanamadi veya eklenti kurulu degildi (cikis kodu: ${res.status}).`);
    }
  }
}

main();
