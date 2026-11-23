'use strict';

/**
 * @fileoverview Cross-platform VSIX installer for Token Sayar (Windows, macOS, Linux).
 * Packages the extension via scripts/package-vsix.js and installs it into detected IDEs.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const TARGETS = [
  { name: 'Antigravity IDE (2.x)', cli: 'antigravity-ide', legacy: false },
  { name: 'Visual Studio Code', cli: 'code', legacy: false },
  { name: 'Antigravity (1.x)', cli: 'antigravity', legacy: true },
];

function parseArgs(argv) {
  let skipLegacy = false;
  let targetCli = null;

  for (const arg of argv) {
    if (arg === '--skip-legacy') {
      skipLegacy = true;
    } else if (arg.startsWith('--target=')) {
      targetCli = arg.slice('--target='.length).trim();
    }
  }

  return { skipLegacy, targetCli };
}

function isCliAvailable(cli) {
  const result = spawnSync(cli, ['--version'], {
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  return result.status === 0 && !result.error;
}

function isExtensionInstalled(cli, extId) {
  const result = spawnSync(cli, ['--list-extensions'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: process.platform === 'win32',
  });
  if (result.status !== 0 || !result.stdout) {
    return false;
  }
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
  return lines.includes(extId.toLowerCase());
}

function printManualGuide(relativeVsixPath) {
  console.log('');
  console.log('Hicbir desteklenen IDE CLI araci (antigravity-ide, code, antigravity) PATH uzerinde bulunamadi.');
  console.log('Eklentiyi IDE arayuzunden kolayca kurabilirsiniz:');
  console.log('  1. IDE icinde Extensions (Eklentiler) panelini acin (Ctrl+Shift+X / Cmd+Shift+X).');
  console.log('  2. Sag ustteki "..." (More Actions) menusune tiklayin.');
  console.log('  3. "Install from VSIX..." secenegini secin.');
  console.log(`  4. Su dosyayi secin: ${relativeVsixPath}`);
  console.log('  5. Kurulumdan sonra "Developer: Reload Window" komutunu calistirin.');
  console.log('');
}

function main() {
  const { skipLegacy, targetCli } = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(__dirname, '..');

  // 1. Package VSIX
  execFileSync(process.execPath, [path.join(__dirname, 'package-vsix.js')], {
    stdio: 'inherit',
  });

  // 2. Read package.json and verify VSIX exists
  const pkgPath = path.join(rootDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const extId = `${pkg.publisher}.${pkg.name}`;
  const vsixFilename = `${pkg.name}-${pkg.version}.vsix`;
  const relativeVsixPath = path.join('dist', vsixFilename);
  const vsixPath = path.join(rootDir, relativeVsixPath);

  if (!fs.existsSync(vsixPath)) {
    console.error(`Hata: Beklenen VSIX dosyasi bulunamadi: ${vsixPath}`);
    process.exitCode = 1;
    return;
  }

  // 3. Filter targets
  let selectedTargets = TARGETS.filter((t) => !(skipLegacy && t.legacy));
  if (targetCli) {
    selectedTargets = selectedTargets.filter((t) => t.cli === targetCli);
    if (selectedTargets.length === 0) {
      selectedTargets = [{ name: targetCli, cli: targetCli, legacy: false }];
    }
  }

  // 4. Detect available CLIs and install
  const availableTargets = selectedTargets.filter((t) => isCliAvailable(t.cli));

  if (availableTargets.length === 0) {
    printManualGuide(relativeVsixPath);
    return;
  }

  let installedCount = 0;

  for (const target of availableTargets) {
    console.log(`[${target.name}] Kurulum baslatiliyor (${target.cli})...`);
    const installRes = spawnSync(target.cli, ['--install-extension', vsixPath, '--force'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    if (installRes.status === 0) {
      console.log(`[${target.name}] Kurulum tamamlandi.`);
      installedCount += 1;
    } else if (isExtensionInstalled(target.cli, extId)) {
      console.log(`[${target.name}] CLI sifir disi cikis kodu dondu ancak eklenti kurulu gorunuyor (${extId}).`);
      installedCount += 1;
    } else {
      console.error(`[${target.name}] Kurulum basarisiz oldu (cikis kodu: ${installRes.status}).`);
    }
  }

  if (installedCount > 0) {
    console.log('');
    console.log('Kurulum tamamlandi. Degisikliklerin aktif olmasi icin IDE icinde "Developer: Reload Window" komutunu calistirin.');
  } else {
    process.exitCode = 1;
  }
}

main();
