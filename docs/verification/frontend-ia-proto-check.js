// 原型校验 harness：抽取 wireframe 里的 <script>，在最小 stub 下真跑一遍。
// 目的：① 语法/运行期错误暴露；② 让原型自己的 measure() 打印步数（可复跑的证据）。
const fs = require('fs');
const vm = require('vm');
const path = 'E:\\Development\\Project\\FamilyAssetManagement\\prototypes\\11-frontend-ia.wireframe.html';
const html = fs.readFileSync(path, 'utf8');

const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('FAIL: 未找到 <script> 块'); process.exit(2); }
const js = m[1];

function stub() {
  const o = {
    dataset: {}, style: {}, className: '', textContent: '', innerHTML: '',
    onclick: null, parentNode: null,
    addEventListener() {}, removeEventListener() {}
  };
  return o;
}
const g = {
  document: { getElementById: () => stub(), addEventListener() {} },
  window: {},
  location: { search: '', hash: '' },
  history: { replaceState() {} },
  alert() {},
  console
};
g.window.console = console;
vm.createContext(g);

// 收集渲染过的 screen HTML 长度，作为「渲染路径真的跑到了」的证据
let rendered = { count: 0 };
try {
  vm.runInContext(js + '\n;globalThis.__probe = { renderShell: renderShell, renderPanel: renderPanel, measure: measure, VARIANTS: VARIANTS, SCR: SCR, ST: ST };', g, { filename: 'wireframe.js' });
} catch (e) {
  console.error('FAIL 运行期异常：' + e.message);
  console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}

const P = g.__probe;
const out = [];
out.push('=== 1. 语法与运行期：通过（脚本已完整执行） ===');

out.push('');
out.push('=== 2. 步数度量（由原型内 BFS 算出） ===');
out.push('口径：一次点击 = 1 步（不含键盘输入）；「保存」本身计 1 步');
for (const V of P.VARIANTS) {
  const r = P.measure(V.k);
  out.push('  ' + r.v + ' ' + V.name + '：首页→记账→保存 ' + r.r1 + ' 步 | 记完→看流水 ' + r.r2 +
    ' 步 | 首页→股票 ' + r.r3 + ' 步 | 最坏(从 ' + r.worstFrom + ')→保存 ' + r.worst + ' 步');
}

out.push('');
out.push('=== 3. 每个变体 × 每个页面都渲染一次（暴露模板异常） ===');
const pages = Object.keys(P.SCR);
let ok = 0, bad = [];
for (const V of P.VARIANTS) {
  P.ST.variant = V.k;
  for (const pg of pages) {
    P.ST.page = pg;
    try {
      const h = P.renderShell(V.k);
      if (!h || h.length < 40) bad.push(V.k + '/' + pg + ' 输出过短');
      else ok++;
    } catch (e) { bad.push(V.k + '/' + pg + ' 抛错: ' + e.message); }
  }
  try { P.renderPanel(); } catch (e) { bad.push(V.k + '/panel 抛错: ' + e.message); }
}
out.push('  渲染成功 ' + ok + ' 组' + (bad.length ? '；失败 ' + bad.length + ' 组' + JSON.stringify(bad) : '；失败 0 组'));

out.push('');
out.push('=== 4. 上游派生要求是否在渲染结果里可见（关键字扫描） ===');
const REQ = [
  ['待同步', '全局「待同步」指示器（#10 R1）'],
  ['b-pend', '流水项待同步视觉状态（#10 R2）'],
  ['待同步记录会保留至下次登录', '登出前「N 条待同步」确认（#10 R3）'],
  ['添加到主屏幕', 'iOS 安装引导条（#10 R4）'],
  ['离线不可用', '离线置灰且说明原因（#10 R5）'],
  ['无「注册」入口', '没有注册页（#10 R6 / #9）'],
  ['无访客链接', '不给访客留位置（#10 R6）'],
  ['不会丢失待同步记录', 'SW 更新提示文案（#10 R7）'],
  ['缓存于', '离线行情双时间戳（#10 R8）'],
  ['未计入汇总', '首页汇总「另有 N 条待同步未计入」（#10 R9）'],
  ['manifest.display', 'standalone 硬门禁提示（#10 Q5 / 门禁 1）'],
  ['inputmode="decimal"', '移动端金额键盘（#10 实现约定）'],
  ['type="text" inputmode="decimal"', '金额输入框确实是 text + decimal，不是 number'],
  ['未细分', '虚拟行「未细分」（#4）'],
  ['未指定对象', '「未指定对象」桶（#4）'],
  ['无上期数据', '上期无数据不给变化率（#4）'],
  ['scheduled_at', '毫秒/秒混单位的坑（#14→#11）'],
  ['采纳只解决送转那一半', '除权两类成分（#13 R11）'],
  ['补数在前', '缺口提示条次序（#13）'],
  ['不可指向未来', '发生时间不可指向未来（#6）']
];
let renderAll = '';
P.ST.variant = 'A';
for (const pg of pages) { P.ST.page = pg; renderAll += P.renderShell('A'); }
P.ST.variant = 'C'; P.ST.page = 'home'; renderAll += P.renderShell('C');
P.ST.online = false; P.ST.queue = 2; P.ST.swUpdate = true;
P.ST.page = 'stock'; renderAll += P.renderShell('A');
P.ST.page = 'home'; renderAll += P.renderShell('A');
P.ST.page = 'entry'; P.ST.variant = 'A'; renderAll += P.renderShell('A');
for (const [kw, label] of REQ) {
  out.push('  ' + (renderAll.includes(kw) ? '✓' : '✗ 缺失') + '  ' + label + '  ← 关键字 ' + JSON.stringify(kw));
}

fs.writeFileSync('E:\\Development\\Project\\FamilyAssetManagement\\docs\\verification\\frontend-ia-proto-check.out.txt',
  out.join('\r\n'), 'utf8');
console.log(out.join('\n'));
