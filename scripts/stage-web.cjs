// 把上游 web/ 复制成 resources/web（排除 21 MB 的 wasm/），并注入 embed 模式样式：
// 带 ?embed=1 时隐藏 workbench 自己的页头和标签栏，只保留板面与控制台。
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const src = path.join(root, "vendor", "esp32sim", "web");
const dst = path.join(root, "resources", "web");

if (!fs.existsSync(src)) {
  console.error("找不到上游 web 目录：" + src);
  process.exit(1);
}

// 覆盖式复制，不整目录删除（避免触发批量删除保护）；run.html 单独覆盖后再打补丁。
fs.mkdirSync(dst, { recursive: true });
for (const name of fs.readdirSync(src)) {
  if (name === "wasm" || name === "run.html") continue;
  fs.cpSync(path.join(src, name), path.join(dst, name), { recursive: true, force: true });
}

const run = path.join(dst, "run.html");
fs.copyFileSync(path.join(src, "run.html"), run);
let html = fs.readFileSync(run, "utf8");
if (!html.includes("desktop-embed")) {
  const inject = `
<style id="desktop-embed">
  html.embed body > header { display: none !important; }
  html.embed .tabs { display: flex !important; flex-wrap: wrap; gap: 6px; }
  html.embed .tabs button { font-size: 11px !important; padding: 2px 7px !important; }
  html.embed main { grid-template-columns: minmax(0, 1fr) !important; padding: 0 !important; gap: 8px !important; }
  html.embed body { overflow: hidden; }
  html.embed #lcdpanel { margin: 0 auto; }
</style>
<script>try{if(new URLSearchParams(location.search).has('embed'))document.documentElement.classList.add('embed')}catch(e){}</script>
`;
  html = html.replace("</head>", inject + "</head>");
  fs.writeFileSync(run, html);
}

console.log("staged web -> " + dst + " (" + fs.readdirSync(dst).length + " entries)");
