#!/usr/bin/env node
// 构建 Sites 交付包：dist-sites 放 sites-ui 三个公开文件；
// dist-sites-function 放 index.ts 及递归相对依赖（仅实际生产依赖）。
// _qoder 由平台部署时注入，不创建、不复制、不清理。
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITES_UI = join(WEB_ROOT, 'sites-ui');
const FUNCTIONS = join(WEB_ROOT, 'functions');
const ENTRY = join(FUNCTIONS, 'index.ts');
const OUT_STATIC = join(WEB_ROOT, 'dist-sites');
const OUT_FUNCTION = join(WEB_ROOT, 'dist-sites-function');
const EVIDENCE = join(WEB_ROOT, '..', '.local', 'sites', 'bundle-evidence.json');
const PUBLIC_FILES = ['index.html', 'style.css', 'app.js'];
const PLATFORM_DIR = '_qoder';

// 静态 import/export（含 import type、副作用导入）与动态 import。
const STATIC_IMPORT = /(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const fail = message => { throw new Error(message); };
const toPosix = file => file.split(sep).join('/');
const show = file => toPosix(relative(WEB_ROOT, file));

async function assertSourceFile(file, label) {
  const info = await lstat(file).catch(() => fail(`${label}不存在：${show(file)}`));
  if (info.isSymbolicLink()) fail(`${label}是符号链接，拒绝打包：${show(file)}`);
  if (!info.isFile()) fail(`${label}不是普通文件：${show(file)}`);
}

function insideFunctions(file) {
  const rel = relative(FUNCTIONS, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`);
}

// 剔除测试、类型声明、本地 runtime、.env 与 node_modules 等非生产文件。
function exclusionReason(file) {
  const rel = toPosix(relative(FUNCTIONS, file));
  const name = basename(file);
  if (rel.split('/').includes('node_modules')) return 'node_modules';
  if (/\.d\.(?:[cm]?ts)$/.test(name)) return '类型声明';
  if (/\.(?:test|spec)\./.test(name)) return '测试';
  if (/^\.env(?:\.|$)/.test(name)) return '.env';
  if (rel === 'runtime.ts') return '本地 runtime';
  return '';
}

async function resolveSource(base) {
  for (const ext of ['', '.ts', '.mjs', '.js', '.mts', '.cts', '.json']) {
    const candidate = `${base}${ext}`;
    let info;
    try { info = await lstat(candidate); } catch (error) { if (error.code !== 'ENOENT') throw error; continue; }
    if (info.isSymbolicLink()) fail(`依赖是符号链接，拒绝打包：${toPosix(relative(FUNCTIONS, candidate))}`);
    if (info.isFile()) return candidate;
  }
  return fail(`无法解析相对依赖：${toPosix(relative(FUNCTIONS, base))}`);
}

function readSpecifiers(source) {
  const specs = new Set();
  for (const pattern of [STATIC_IMPORT, DYNAMIC_IMPORT]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source))) specs.add(match[1]);
  }
  return specs;
}

async function collectFunctionFiles() {
  await assertSourceFile(ENTRY, '入口文件');
  const queue = [ENTRY];
  const files = new Set(queue);
  const excluded = new Map();
  while (queue.length) {
    const current = queue.shift();
    for (const specifier of readSpecifiers(await readFile(current, 'utf8'))) {
      // 非相对依赖属于平台或运行时，不进入本次自包含包。
      if (!specifier.startsWith('.')) continue;
      const base = resolve(dirname(current), specifier);
      if (!insideFunctions(base)) fail(`依赖越出 functions 目录：${specifier}（来自 ${toPosix(relative(FUNCTIONS, current))}）`);
      const relBase = toPosix(relative(FUNCTIONS, base));
      if (relBase.split('/').includes(PLATFORM_DIR)) { excluded.set(show(base), '平台注入'); continue; }
      const file = await resolveSource(base);
      const reason = exclusionReason(file);
      if (reason) { excluded.set(show(file), reason); continue; }
      if (!files.has(file)) { files.add(file); queue.push(file); }
    }
  }
  return { files: [...files].sort(), excluded };
}

async function assertOutputDirectory(root, label) {
  let info;
  try { info = await lstat(root); } catch (error) { if (error.code !== 'ENOENT') throw error; return; }
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label}不是普通目录：${root}`);
}

// 列出既有文件；顶层 _qoder 由平台管理，忽略且不写入。
async function listExistingFiles(root) {
  const found = [];
  async function walk(dir, prefix) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (!prefix && entry.name === PLATFORM_DIR) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) found.push({ rel, symlink: true });
      else if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else found.push({ rel, symlink: false });
    }
  }
  await walk(root, '');
  return found;
}

async function assertNoUnknownFiles(root, expected, label) {
  const unknown = (await listExistingFiles(root)).filter(item => item.symlink || !expected.has(item.rel)).map(item => item.rel);
  if (unknown.length) fail(`${label}已有未知文件，未删除任何内容：${unknown.join(', ')}`);
}

async function writeBundle(root, entries) {
  await mkdir(root, { recursive: true });
  const files = [];
  for (const { source, rel } of entries) {
    const data = await readFile(source);
    const target = join(root, ...rel.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
    files.push({ path: rel, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  }
  return { directory: basename(root), files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

async function main() {
  const staticEntries = [];
  for (const name of PUBLIC_FILES) {
    const source = join(SITES_UI, name);
    await assertSourceFile(source, '静态文件');
    staticEntries.push({ source, rel: name });
  }
  const { files, excluded } = await collectFunctionFiles();
  const functionEntries = files.map(source => ({ source, rel: toPosix(relative(FUNCTIONS, source)) }));
  if (functionEntries.some(entry => entry.rel.split('/').includes(PLATFORM_DIR))) fail('拒绝打包平台注入目录');
  // 先完成全部检查，确认没有未知文件后再写入，避免留下半成品。
  await assertOutputDirectory(OUT_STATIC, '静态输出目录');
  await assertOutputDirectory(OUT_FUNCTION, 'Function 输出目录');
  await assertNoUnknownFiles(OUT_STATIC, new Set(staticEntries.map(entry => entry.rel)), '静态输出目录');
  await assertNoUnknownFiles(OUT_FUNCTION, new Set(functionEntries.map(entry => entry.rel)), 'Function 输出目录');
  const outputs = [await writeBundle(OUT_STATIC, staticEntries), await writeBundle(OUT_FUNCTION, functionEntries)];
  const evidence = {
    generatedAt: new Date().toISOString(),
    entry: 'functions/index.ts',
    outputs,
    excluded: [...excluded].map(([path, reason]) => ({ path, reason })).sort((a, b) => a.path.localeCompare(b.path)),
  };
  await mkdir(dirname(EVIDENCE), { recursive: true });
  await writeFile(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
  const summary = outputs.map(item => `${item.directory}(${item.files.length})`).join('，');
  console.log(`[build:sites] 完成：${summary}；证据已写入 ${toPosix(relative(WEB_ROOT, EVIDENCE))}`);
}

try {
  await main();
} catch (error) {
  console.error(`[build:sites] 失败：${error.message}`);
  process.exitCode = 1;
}
