// 将服务端打包为 Node.js 单文件可执行程序（Single Executable Application）
// 用法：npm run build  →  dist/katanpro-<platform>-<arch>
// 产物自带 Node 运行时与内嵌前端资源，拷贝到目标机器 chmod +x 即可运行。
import { build } from 'esbuild';
import { chmodSync, cpSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const outName = `katanpro-${process.platform}-${process.arch}`;
const postject = join(root, 'node_modules', '.bin', 'postject');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });
  if (r.status !== 0) throw new Error(`命令失败: ${cmd} ${args.join(' ')}`);
}

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p).split(sep).join('/'));
  }
  return out.sort();
}

console.log('1/4 打包服务端（esbuild bundle → CJS）');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
await build({
  entryPoints: [join(root, 'server.js')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: join(dist, 'server.cjs'),
  // SEA 以 CJS 运行主脚本，import.meta.url 不可用；
  // 重定向到「可执行文件所在目录」，使 public/ 与 .env 的外置回退路径保持正确。
  define: { 'import.meta.url': '__sea_import_meta_url' },
  banner: {
    js: "const __sea_import_meta_url = require('url').pathToFileURL(require('path').join(require('path').dirname(process.execPath), 'katanpro.mjs')).href;",
  },
});

console.log('2/4 生成 SEA 配置（内嵌 public/ 静态资源）');
const files = walk(join(root, 'public'));
const assets = {};
for (const f of files) assets['public/' + f] = resolve(root, 'public', f);
writeFileSync(join(dist, 'asset-manifest.json'), JSON.stringify({ files }));
assets.manifest = join(dist, 'asset-manifest.json');
writeFileSync(join(dist, 'sea-config.json'), JSON.stringify({
  main: 'server.cjs',
  output: 'sea-prep.blob',
  disableExperimentalSEAWarning: true,
  assets,
}, null, 2));
run(process.execPath, ['--experimental-sea-config', 'sea-config.json'], { cwd: dist });

console.log('3/4 注入 SEA 快照到 Node 二进制副本');
const bin = join(dist, outName);
cpSync(process.execPath, bin);
chmodSync(bin, 0o755);
if (process.platform === 'darwin') run('codesign', ['--remove-signature', bin]);
run(postject, [
  bin, 'NODE_SEA_BLOB', join(dist, 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
]);
if (process.platform === 'darwin') run('codesign', ['--sign', '-', bin]);

console.log(`4/4 完成：dist/${outName}`);
console.log('部署：拷贝到目标机器（同平台同架构），与可选的 .env 放同一目录，直接运行。');
