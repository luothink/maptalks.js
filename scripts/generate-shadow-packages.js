#!/usr/bin/env node
/**
 * 一键生成精简影子包（dist + 手写 package.json）
 * 用法：
 *   node scripts/generate-shadow-packages.js --out <目标目录> --scene <A|A+|A++|B|B+|C|D|E|all>
 *   node scripts/generate-shadow-packages.js --out <目标目录> --packages maptalks,maptalks-gl,analysis
 *
 * 示例：
 *   // 项目最常用场景：maptalks-gl + analysis
 *   node scripts/generate-shadow-packages.js --out ../my-project/vendor/maptalks --scene A+
 *
 *   // 完整全套
 *   node scripts/generate-shadow-packages.js --out ../my-project/vendor/maptalks --scene all
 *
 *   // 自定义包列表（逗号分隔，包名即 npm 包名或影子包目录名）
 *   node scripts/generate-shadow-packages.js --out ../my-project/vendor/maptalks --packages maptalks,maptalks-gl,analysis,traffic
 */

const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// 9 个影子包的完整定义（包名 → 配置）
// distSrc: 本仓库 packages 中 dist 的绝对/相对源路径（相对仓库根）
// extraFiles: 除 dist 外需要复制的文件（聚合包的 index.js / index.d.ts）
// packageJson: 精简后的 package.json 内容（对象形式，会被 JSON.stringify 写出）
//              version 仅作兜底，实际会从源 packages/<pkg>/package.json 动态读取
// pkgJsonModuleFix: 如果是聚合包，把 "module": "index.js" 改为 "module": "dist/xxx.js" 的推荐写法；默认 false，脚本会提示
// ─────────────────────────────────────────────
const REPO_ROOT = path.resolve(__dirname, '..');

const PACKAGE_DEFS = {
  // ── 3 个聚合/核心包 ──────────────────────
  'maptalks-gl': {
    distSrc: 'packages/maptalks-gl/dist',
    extraFiles: ['packages/maptalks-gl/index.js', 'packages/maptalks-gl/index.d.ts'],
    packageJson: {
      name: 'maptalks-gl',
      version: '0.124.4',
      description: 'All-in-one package for maptalks webgl layers (maptalks core + @maptalks/gl + @maptalks/vt + @maptalks/3dtiles + @maptalks/gltf-layer + @maptalks/transform-control + @maptalks/video-layer)',
      license: 'MIT',
      main: 'dist/maptalks-gl.js',
      module: 'dist/maptalks-gl.js',
      unpkg: 'dist/maptalks-gl.js',
      jsdelivr: 'dist/maptalks-gl.js',
      types: 'index.d.ts',
      style: 'dist/maptalks-gl.css',
      files: [
        'dist/images/**/*',
        'dist/maptalks-gl.css',
        'dist/maptalks-gl.js',
        'dist/maptalks-gl.js.map',
        'index.js',
        'index.d.ts'
      ],
      dependencies: {}
    }
  },
  'maptalks-gpu': {
    distSrc: 'packages/maptalks-gpu/dist',
    extraFiles: ['packages/maptalks-gpu/index.js', 'packages/maptalks-gpu/index.d.ts'],
    packageJson: {
      name: 'maptalks-gpu',
      version: '0.124.4',
      description: 'All-in-one package for maptalks WebGPU layers (maptalks core + @maptalks/gpu + @maptalks/gl + @maptalks/vt + @maptalks/3dtiles + @maptalks/gltf-layer + @maptalks/transform-control + @maptalks/video-layer)',
      license: 'MIT',
      main: 'dist/maptalks-gpu.js',
      module: 'dist/maptalks-gpu.js',
      unpkg: 'dist/maptalks-gpu.js',
      jsdelivr: 'dist/maptalks-gpu.js',
      types: 'index.d.ts',
      style: 'dist/maptalks-gpu.css',
      files: [
        'dist/images/**/*',
        'dist/maptalks-gpu.css',
        'dist/maptalks-gpu.js',
        'dist/maptalks-gpu.js.map',
        'index.js',
        'index.d.ts'
      ],
      dependencies: {}
    }
  },
  maptalks: {
    distSrc: 'packages/maptalks/dist',
    extraFiles: [],
    packageJson: {
      name: 'maptalks',
      version: '1.12.1',
      description: 'A light JavaScript library to create integrated 2D/3D maps.',
      license: 'BSD-3-Clause',
      main: 'dist/maptalks.js',
      module: 'dist/maptalks.es.js',
      types: 'dist/index.d.ts',
      unpkg: 'dist/maptalks.min.js',
      jsdelivr: 'dist/maptalks.min.js',
      style: 'dist/maptalks.css',
      files: [
        'ACKNOWLEDGEMENT',
        'dist/**/*'
      ],
      dependencies: {
        '@maptalks/feature-filter': '^1.3.0',
        '@maptalks/function-type': '^1.4.1',
        colorin: '^0.6.0',
        'frustum-intersects': '^0.1.0',
        lineclip: '^1.1.5',
        rbush: '^2.0.2',
        'simplify-js': '^1.2.1'
      }
    }
  },

  // ── 5 个独立插件（不打进聚合包）─────────────
  analysis: {
    distSrc: 'packages/analysis/dist',
    extraFiles: [],
    packageJson: {
      name: '@maptalks/analysis',
      version: '0.124.4',
      description: 'a plugin to excute many analysis tasks (excavation, cut, flood, viewshed, skyline...)',
      license: 'MIT',
      main: 'dist/maptalks.analysis.js',
      module: 'dist/maptalks.analysis.es.js',
      types: 'dist/index.d.ts',
      files: ['dist/**/*'],
      exports: {
        '.': {
          types: './dist/index.d.ts',
          import: './dist/maptalks.analysis.es.js',
          require: './dist/maptalks.analysis.js'
        },
        './dist/*': './dist/*',
        './package.json': './package.json'
      },
      dependencies: {
        '@turf/along': '^6.5.0',
        '@turf/buffer': '^6.5.0',
        '@turf/distance': '^6.5.0',
        '@turf/helpers': '^6.5.0'
      }
    }
  },
  traffic: {
    distSrc: 'packages/traffic/dist',
    extraFiles: [],
    packageJson: {
      name: '@maptalks/traffic',
      version: '0.124.4',
      description: 'a tool to render traffic effect',
      main: 'dist/maptalks.traffic.js',
      module: 'dist/maptalks.traffic.es.js',
      types: 'dist/maptalks.traffic.d.ts',
      unpkg: 'dist/maptalks.traffic.js',
      jsdelivr: 'dist/maptalks.traffic.js',
      files: ['dist/**/*'],
      dependencies: {}
    }
  },
  'transcoders-draco': {
    distSrc: 'packages/transcoders.draco/dist',
    extraFiles: [],
    packageJson: {
      name: '@maptalks/transcoders.draco',
      version: '0.124.4',
      description: 'draco transcoder for @maptalks/gl (3D Tiles / gltf draco compressed geometry decoder)',
      license: 'ISC',
      main: 'dist/transcoders.draco.js',
      module: 'dist/transcoders.draco.es.js',
      files: ['dist/**/*'],
      dependencies: {}
    }
  },
  'transcoders-crn': {
    distSrc: 'packages/transcoders.crn/dist',
    extraFiles: [],
    packageJson: {
      name: '@maptalks/transcoders.crn',
      version: '0.124.4',
      description: 'crn transcoder for @maptalks/gl (crn compressed texture decoder)',
      license: 'ISC',
      main: 'dist/transcoders.crn.js',
      module: 'dist/transcoders.crn.es.js',
      files: ['dist/**/*'],
      dependencies: {}
    }
  },
  'transcoders-ktx2': {
    // ⚠️ 注意：本地目录名是 transcoders.ktx（无 2），npm 包名是 transcoders.ktx2（有 2）
    distSrc: 'packages/transcoders.ktx/dist',
    extraFiles: [],
    packageJson: {
      name: '@maptalks/transcoders.ktx2',
      version: '0.124.4',
      description: 'ktx2 transcoder for @maptalks/gl (ktx2 compressed texture decoder)',
      license: 'ISC',
      main: 'dist/transcoders.ktx2.js',
      module: 'dist/transcoders.ktx2.es.js',
      files: ['dist/**/*'],
      dependencies: {}
    }
  }
};

// ─────────────────────────────────────────────
// 场景定义（场景名 → 包含的影子包 key 数组）
// ─────────────────────────────────────────────
const SCENES = {
  A:    ['maptalks-gl'],
  'A+': ['maptalks-gl', 'analysis'],
  'A++':['maptalks-gl', 'analysis', 'traffic', 'transcoders-draco', 'transcoders-crn', 'transcoders-ktx2'],
  B:    ['maptalks-gpu'],
  'B+': ['maptalks-gpu', 'analysis'],
  C:    ['maptalks'],
  D:    ['maptalks', 'analysis'],
  E:    ['maptalks', 'maptalks-gl', 'analysis'],
  all:  Object.keys(PACKAGE_DEFS)
};

// ─────────────────────────────────────────────
// CLI 参数解析
// ─────────────────────────────────────────────
function parseArgs(argv) {
  const args = { out: null, scene: null, packages: null, help: false, force: false, internal: false, relative: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' || a === '-o')      args.out = argv[++i];
    else if (a === '--scene' || a === '-s') args.scene = argv[++i];
    else if (a === '--packages' || a === '-p') args.packages = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--force' || a === '-f') args.force = true;
    else if (a === '--internal' || a === '-i') args.internal = true;
    else if (a === '--relative' || a === '-r') args.relative = argv[++i];
  }
  // --internal 快捷：等价于 -o vendor/maptalks -r ./vendor/maptalks
  if (args.internal) {
    if (!args.out) args.out = 'vendor/maptalks';
    if (!args.relative) args.relative = './vendor/maptalks';
  }
  // ✅ 默认无参：pnpm gen-shadow 直接回车 → 等价于 -i -s all（内部路径 + 全套 8 个包）
  const noRequiredArgs = !args.out && !args.scene && !args.packages;
  if (noRequiredArgs) {
    args.internal = true;
    args.scene = 'all';
    if (!args.out) args.out = 'vendor/maptalks';
    if (!args.relative) args.relative = './vendor/maptalks';
  }
  return args;
}

function printHelp() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║          maptalks.js 精简影子包一键生成工具                   ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║ 用法：                                                       ║
║   node scripts/generate-shadow-packages.js [选项]            ║
║   pnpm gen-shadow [选项]          （通过 package.json 别名）  ║
║                                                              ║
║ 选项：                                                       ║
║   --internal, -i         ✨ 在本仓库根目录直接生成，输出到    ║
║                           ./vendor/maptalks/（推荐默认）     ║
║                           等价于 -o vendor/maptalks \\        ║
║                                      -r ./vendor/maptalks    ║
║                                                              ║
║   --out, -o <目录>       自定义影子包输出目录                 ║
║                           例：../my-project/vendor/maptalks   ║
║                                                              ║
║   --relative, -r <前缀>  覆盖最终生成的 package.json 片段中  ║
║                           file: 协议的相对路径前缀            ║
║                           例：-r ./vendor/maptalks            ║
║                                                              ║
║   --scene, -s <场景>     按场景批量生成，支持：                ║
║                           A     = maptalks-gl                 ║
║                           A+    = maptalks-gl + analysis      ║
║                                            ⬅ 项目最常用   ║
║                           A++   = A+ + traffic + 转码器 x3    ║
║                           B     = maptalks-gpu                ║
║                           B+    = maptalks-gpu + analysis     ║
║                           C     = maptalks (纯 2D)            ║
║                           D     = maptalks + analysis         ║
║                           E     = maptalks + maptalks-gl + a. ║
║                           all   = 全部 8 个影子包             ║
║                                                              ║
║   --packages, -p <列表>   自定义包列表（逗号分隔）             ║
║                           例：maptalks,maptalks-gl,analysis   ║
║                                                              ║
║   --force, -f            若输出目录存在则先清空                ║
║   --help, -h             显示本帮助                           ║
║                                                              ║
║ 示例（推荐：内部生成 + 相对路径）：                           ║
║   # ✨ pnpm gen-shadow 直接回车（默认无参）= 全套 8 个包     ║
║   #    输出到 ./vendor/maptalks，片段 ./vendor/maptalks/xxx     ║
║   pnpm gen-shadow                                            ║
║                                                              ║
║   # 覆盖旧内容重生成全套                                      ║
║   pnpm gen-shadow --force                                    ║
║                                                              ║
║   # ✨ 项目 A+ 场景：只生成 maptalks-gl + analysis          ║
║   pnpm gen-shadow -i -s A+                                   ║
║                                                              ║
║   # 自定义场景 + 覆盖旧内容                                   ║
║   pnpm gen-shadow -i -s A++ --force                          ║
║                                                              ║
║ 示例（输出到外部业务项目目录）：                               ║
║   pnpm gen-shadow -o ../my-project/vendor/maptalks -s A+     ║
║                                                              ║
║   # 自定义包列表                                             ║
║   pnpm gen-shadow -o ../my-project/vendor/maptalks \\         ║
║                    -p maptalks,maptalks-gpu,analysis,traffic ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`);
}

// ─────────────────────────────────────────────
// 工具函数：递归复制目录
// ─────────────────────────────────────────────
function copyRecursiveSync(src, dest) {
  const exists = fs.existsSync(src);
  if (!exists) {
    throw new Error(`源路径不存在: ${src}`);
  }
  const stats = fs.statSync(src);
  const isDir = stats.isDirectory();
  if (isDir) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    for (const entry of fs.readdirSync(src)) {
      const srcPath = path.join(src, entry);
      const destPath = path.join(dest, entry);
      copyRecursiveSync(srcPath, destPath);
    }
  } else {
    const destDir = path.dirname(dest);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    fs.copyFileSync(src, dest);
  }
}

function rmrf(dir) {
  if (!fs.existsSync(dir)) return;
  const stat = fs.statSync(dir);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(dir)) {
      rmrf(path.join(dir, entry));
    }
    fs.rmdirSync(dir);
  } else {
    fs.unlinkSync(dir);
  }
}

// ─────────────────────────────────────────────
// 工具函数：读取源包 package.json 中的真实版本号
// distSrc 形如 packages/<pkg>/dist，其上一级即源包目录
// ─────────────────────────────────────────────
function readSourceVersion(def) {
  const pkgDir = path.resolve(REPO_ROOT, path.dirname(def.distSrc));
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    return pkg.version || null;
  } catch (e) {
    return null;
  }
}

// ─────────────────────────────────────────────
// 核心生成逻辑
// ─────────────────────────────────────────────
function generatePackage(pkgKey, outDir) {
  const def = PACKAGE_DEFS[pkgKey];
  if (!def) {
    throw new Error(`未知的包 key: ${pkgKey}，可选: ${Object.keys(PACKAGE_DEFS).join(', ')}`);
  }
  const targetDir = path.resolve(outDir, pkgKey);

  // 1. 清空/创建目标目录
  if (fs.existsSync(targetDir)) rmrf(targetDir);
  fs.mkdirSync(targetDir, { recursive: true });

  // 2. 复制 dist 目录
  const distSrc = path.resolve(REPO_ROOT, def.distSrc);
  if (!fs.existsSync(distSrc)) {
    console.warn(`  ⚠️  ${pkgKey}: dist 源目录不存在 → ${path.relative(REPO_ROOT, distSrc)}`);
    console.warn(`       请先执行: pnpm build-all`);
  } else {
    copyRecursiveSync(distSrc, path.join(targetDir, 'dist'));
    console.log(`  ✅ ${pkgKey}: dist 复制完成`);
  }

  // 3. 复制额外文件（聚合包的 index.js / index.d.ts）
  for (const f of def.extraFiles || []) {
    const src = path.resolve(REPO_ROOT, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(targetDir, path.basename(f)));
      console.log(`  ✅ ${pkgKey}: 额外文件 ${path.basename(f)} 复制完成`);
    } else {
      console.warn(`  ⚠️  ${pkgKey}: 额外文件不存在 → ${path.relative(REPO_ROOT, src)}`);
    }
  }

  // 4. 写入 package.json（版本号从源包 package.json 动态读取）
  const sourceVersion = readSourceVersion(def);
  if (!sourceVersion) {
    console.warn(`  ⚠️  ${pkgKey}: 未能读取源 package.json 版本号，沿用内置兜底版本 ${def.packageJson.version}`);
  }
  const packageJson = { ...def.packageJson, version: sourceVersion || def.packageJson.version };
  const pkgJsonPath = path.join(targetDir, 'package.json');
  fs.writeFileSync(
    pkgJsonPath,
    JSON.stringify(packageJson, null, 2) + '\n',
    'utf-8'
  );
  console.log(`  ✅ ${pkgKey}: package.json 写入完成（version: ${packageJson.version}）`);

  // 5. 复制 maptalks 核心的 ACKNOWLEDGEMENT 文件（如果存在且目标是 maptalks 包）
  if (pkgKey === 'maptalks') {
    const ackSrc = path.resolve(REPO_ROOT, 'packages/maptalks/ACKNOWLEDGEMENT');
    if (fs.existsSync(ackSrc)) {
      fs.copyFileSync(ackSrc, path.join(targetDir, 'ACKNOWLEDGEMENT'));
      console.log(`  ✅ ${pkgKey}: ACKNOWLEDGEMENT 复制完成`);
    }
  }
}

// ─────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); process.exit(0); }

  if (!args.out) {
    console.error('❌ 必须指定输出目录（用 --out/-o，或加 --internal/-i 直接生成到 ./vendor/maptalks）');
    printHelp();
    process.exit(1);
  }
  if (!args.scene && !args.packages) {
    console.error('❌ 必须指定 --scene <场景> 或 --packages <列表>');
    printHelp();
    process.exit(1);
  }

  // 解析包列表
  let pkgKeys;
  if (args.packages) {
    pkgKeys = args.packages.split(',').map(s => s.trim()).filter(Boolean);
    // 校验
    for (const k of pkgKeys) {
      if (!PACKAGE_DEFS[k]) {
        console.error(`❌ 未知包名: ${k}，支持: ${Object.keys(PACKAGE_DEFS).join(', ')}`);
        process.exit(1);
      }
    }
  } else {
    if (!SCENES[args.scene]) {
      console.error(`❌ 未知场景: ${args.scene}，支持: ${Object.keys(SCENES).join(', ')}`);
      process.exit(1);
    }
    pkgKeys = SCENES[args.scene];
  }

  const outDir = path.resolve(args.out);

  // 输出目录检查
  if (fs.existsSync(outDir) && !args.force) {
    const children = fs.readdirSync(outDir);
    if (children.length > 0) {
      console.error(`❌ 输出目录已存在且非空: ${outDir}`);
      console.error('   加 --force 参数可先清空再生成。');
      process.exit(1);
    }
  }
  if (args.force && fs.existsSync(outDir)) {
    rmrf(outDir);
  }
  fs.mkdirSync(outDir, { recursive: true });

  // 标题打印
  console.log(`
╔══════════════════════════════════════════╗
║  maptalks.js 精简影子包生成              ║
╠══════════════════════════════════════════╣
║  输出目录: ${path.relative(process.cwd(), outDir) || '.'}
║  生成数量: ${pkgKeys.length} 个包
║  包列表  : ${pkgKeys.join(', ')}
╚══════════════════════════════════════════╝
`);

  // 逐个生成
  for (const key of pkgKeys) {
    generatePackage(key, outDir);
  }

  // 生成业务项目 package.json 片段（复制即用）
  console.log(`
╔══════════════════════════════════════════╗
║  ✅ 生成完成！粘贴到业务项目 package.json ║
╚══════════════════════════════════════════╝
`);
  const depBlock = {};
  for (const key of pkgKeys) {
    const name = PACKAGE_DEFS[key].packageJson.name;
    if (args.relative) {
      // 用户指定了相对路径前缀（如 -r ./vendor/maptalks），直接拼
      const prefix = args.relative.replace(/\\/g, '/').replace(/\/+$/, '');
      depBlock[name] = `file:${prefix}/${key}`;
    } else {
      // 默认：按 outDir 往上退一级推断相对路径（原来的行为）
      depBlock[name] = `file:./${path.relative(path.resolve(outDir, '..'), outDir).replace(/\\/g, '/') || '.'}/${key}`;
    }
  }
  console.log('"dependencies": ' + JSON.stringify(depBlock, null, 2)
    .split('\n').map(l => '  ' + l).join('\n'));

  // --internal 模式额外提示：把生成的 maptalks.js/vendor/maptalks 目录整个复制到业务项目
  if (args.internal) {
    console.log(`
💡 已使用 --internal 模式。把 maptalks.js/vendor/maptalks 整个目录复制到你的业务项目同级位置即可使用，
   或者直接在本项目（maptalks.js）的 package.json 中加入上面的依赖片段进行本地联调。
   如需覆盖旧内容重跑，加 --force：
       pnpm gen-shadow -i -s A+ --force
`);
  }

  // maptalks 依赖的第三方包提示
  const extraNpmDeps = new Set();
  for (const key of pkgKeys) {
    const deps = PACKAGE_DEFS[key].packageJson.dependencies || {};
    for (const d of Object.keys(deps)) {
      if (!d.startsWith('@maptalks/') && d !== 'maptalks' && d !== 'maptalks-gl' && d !== 'maptalks-gpu') {
        extraNpmDeps.add(`"${d}": "${deps[d]}"`);
      }
    }
  }
  if (extraNpmDeps.size > 0) {
    console.log(`\n💡 以下第三方依赖会通过 ${pkgKeys.includes('maptalks') ? 'maptalks' : 'analysis'} 的 package.json dependencies 自动安装，无需手动加：`);
    console.log('  ' + Array.from(extraNpmDeps).join('\n  '));
  }
}

try {
  main();
} catch (e) {
  console.error('\n❌ 执行出错：', e.message);
  process.exit(1);
}
