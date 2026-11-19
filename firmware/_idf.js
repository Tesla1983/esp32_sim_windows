// 用本机 IDF 环境跑 idf.py 的包装。
//
// 存在的理由：Git Bash 会把 MSYSTEM/SHELL 带进子进程，干扰 IDF 的 shell 检测；工具链也不在
// PATH 上。这里显式给一份干净环境，并在 IDF_TOOLS_PATH 里自动挑出最新的 xtensa 工具链、
// ninja、cmake 与 python venv，所以不用把本机路径写死。
//
// 用法：
//   export IDF_PATH=<esp-idf 目录>
//   export IDF_TOOLS_PATH=<EIM 的工具目录>
//   node firmware/_idf.js -C firmware/co5300-qspi set-target esp32s3
//   node firmware/_idf.js -C firmware/co5300-qspi build
//
// 可选：IDF_PYTHON 直接指定解释器，跳过自动查找。

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function die(msg) {
  console.error(msg);
  process.exit(2);
}

/// 取 dir 下名字最大的子目录里是否存在 suffix 路径；用于版本化目录（带日期/版本号）。
function newest(dir, suffix) {
  if (!fs.existsSync(dir)) return null;
  const names = fs
    .readdirSync(dir)
    .filter((n) => fs.statSync(path.join(dir, n)).isDirectory())
    .sort();
  for (let i = names.length - 1; i >= 0; i--) {
    const candidate = path.join(dir, names[i], ...suffix);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/// Git Bash 里 export 出来的是 /c/... 形式，Windows 的 fs 认不出来，转成 C:/...
function winPath(p) {
  if (process.platform !== "win32" || !p) return p;
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(p);
  return m ? m[1].toUpperCase() + ":/" + m[2] : p;
}

const IDF_PATH = winPath(process.env.IDF_PATH);
const IDF_TOOLS = winPath(process.env.IDF_TOOLS_PATH);
if (!IDF_PATH) die("需要 IDF_PATH 指向 esp-idf 目录");
if (!IDF_TOOLS) die("需要 IDF_TOOLS_PATH 指向 EIM 的工具目录（含 xtensa-esp-elf/、ninja/、python/）");
if (!fs.existsSync(path.join(IDF_PATH, "tools/idf.py"))) die("IDF_PATH 下没有 tools/idf.py：" + IDF_PATH);

const venvPython = process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"];
// EIM 的布局是 python/<版本>/venv/Scripts/python.exe，先找 venv 再退一步直接找解释器。
const PYTHON = process.env.IDF_PYTHON || newest(path.join(IDF_TOOLS, "python"), ["venv", ...venvPython])
  || newest(path.join(IDF_TOOLS, "python"), venvPython);
const TOOLCHAIN = newest(path.join(IDF_TOOLS, "xtensa-esp-elf"), ["xtensa-esp-elf", "bin"]);
const NINJA = newest(path.join(IDF_TOOLS, "ninja"), []);
const CMAKE = newest(path.join(IDF_TOOLS, "cmake"), ["bin"]);

if (!PYTHON) die("在 " + IDF_TOOLS + "/python 下找不到 venv 解释器，可用 IDF_PYTHON 指定");
if (!TOOLCHAIN) die("在 " + IDF_TOOLS + "/xtensa-esp-elf 下找不到工具链（ESP32-S3 是 Xtensa，不是 RISC-V）");

const args = process.argv.slice(2);
if (!args.length) die("用法：node firmware/_idf.js <idf.py 参数...>");

const env = { ...process.env };
for (const key of ["MSYSTEM", "MSYS", "MINGW_PREFIX", "MSYSCON", "SHELL"]) delete env[key];
env.IDF_PATH = IDF_PATH;
env.IDF_TOOLS_PATH = IDF_TOOLS;
env.IDF_PYTHON_ENV_PATH = path.dirname(path.dirname(PYTHON));
// idf_component_manager 拿它做版本比较，缺了会 Version.coerce(None) 崩。
// 优先用 version.txt（release 包里有），没有就从 tools/cmake/version.cmake 拼出来。
function idfVersion() {
  const txt = path.join(IDF_PATH, "version.txt");
  if (fs.existsSync(txt)) return fs.readFileSync(txt, "utf8").trim();
  const cmake = path.join(IDF_PATH, "tools/cmake/version.cmake");
  if (fs.existsSync(cmake)) {
    const src = fs.readFileSync(cmake, "utf8");
    const num = (k) => (new RegExp(k + "\\s+(\\d+)").exec(src) || [])[1] || "0";
    return `${num("IDF_VERSION_MAJOR")}.${num("IDF_VERSION_MINOR")}.${num("IDF_VERSION_PATCH")}`;
  }
  die("拿不到 IDF 版本：既没有 version.txt 也没有 tools/cmake/version.cmake");
}
env.ESP_IDF_VERSION = env.ESP_IDF_VERSION || idfVersion();
env.PATH = [TOOLCHAIN, NINJA, CMAKE, path.dirname(PYTHON), env.PATH].filter(Boolean).join(path.delimiter);

const child = spawn(PYTHON, [path.join(IDF_PATH, "tools/idf.py"), ...args], { env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
