// esp32sim-desktop 技能的唯一入口：把本仓库现有的构建/仿真/日志/截图能力包成结构化命令。
// 只调用本仓库自带的 sidecar 与脚本，绝不接触探针、COM 口或任何真实硬件。
//
// 用法：node <this> <build|run|buslog|panel-shot> [flags...]
// 所有子命令只往 stdout 写一份 JSON，便于 AI 直接解析。

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "../../../..");
const STATE_DIR = path.join(ROOT, ".workbuddy/state/esp32sim-desktop");
const SKILL_DIR = path.join(ROOT, ".workbuddy/skills/esp32sim-desktop");

class SkillError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details || {};
  }
}

function emit(result) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (result.status === "error") process.exitCode = 1;
}

function fail(action, err) {
  emit({
    status: "error",
    action,
    error: {
      code: err.code || "internal_error",
      message: err.message || String(err),
      details: err.details || {},
    },
  });
}

function ok(action, summary, extra) {
  emit(Object.assign({ status: "ok", action, summary }, extra || {}));
}

function parseArgs(tokens) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith("--")) {
      positional.push(t);
      continue;
    }
    const eq = t.indexOf("=");
    const key = (eq < 0 ? t.slice(2) : t.slice(2, eq)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    let value;
    if (eq >= 0) {
      value = t.slice(eq + 1);
    } else if (i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
      value = tokens[++i];
    } else {
      value = true;
    }
    if (flags[key] === undefined) flags[key] = value;
    else if (Array.isArray(flags[key])) flags[key].push(value);
    else flags[key] = [flags[key], value];
  }
  return { positional, flags };
}

function asArray(v) {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function resolvePath(p) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

function defaultConfig() {
  return {
    sidecar: "dist/portable/esp32sim.exe",
    build_sidecar: "scripts/build-sidecar.ps1",
    stage_web: "scripts/stage-web.cjs",
    max_seconds: 8,
    operation_mode: 1,
  };
}

function loadConfig(flags) {
  const cfg = defaultConfig();
  const cfgPath = path.join(SKILL_DIR, "config.json");
  if (fs.existsSync(cfgPath)) Object.assign(cfg, JSON.parse(fs.readFileSync(cfgPath, "utf8")));
  if (process.env.ESP32SIM_EXE) cfg.sidecar = process.env.ESP32SIM_EXE;
  if (process.env.ESP32SIM_MAX_SECONDS) cfg.max_seconds = Number(process.env.ESP32SIM_MAX_SECONDS);
  return cfg;
}

/// 复刻 src/index.html 的 DEVICE_KINDS 总线归类：从源码读，避免两边清单漂移。
function kindBusMap() {
  const html = fs.readFileSync(path.join(ROOT, "src/index.html"), "utf8");
  const map = {};
  const re = /\{\s*v:\s*"([^"]+)"[^}]*?\bbus:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) map[m[1]] = m[2];
  return map;
}

/// 与前端 deviceSpecs() 相同的规则：只有真的连过线的器件才下发引脚。
function specsFromDevices(devices) {
  const kinds = kindBusMap();
  return (devices || []).map((d) => {
    const bus = kinds[d.kind] || "i2c";
    if (bus === "i2c") {
      if (d.sda && d.scl) return [d.bus, d.addr, d.sda, d.scl, d.kind].join(":");
      return [d.bus, d.addr, d.kind].join(":");
    }
    if (bus === "gpio") return [d.pin, d.leds, d.kind].join(":");
    if (bus === "spi") return [d.sclk, d.mosi, d.cs, d.dc, d.kind].join(":");
    if (d.sclk && d.cs) return [d.host, d.width, d.height, d.xoff, d.sclk, d.cs, d.kind].join(":");
    return [d.host, d.width, d.height, d.xoff, d.kind].join(":");
  });
}

function withCargoPath() {
  const env = Object.assign({}, process.env);
  const extra = process.env.CARGO_HOME ? path.join(process.env.CARGO_HOME, "bin") : path.join(require("os").homedir(), ".cargo/bin");
  if (fs.existsSync(extra) && !env.PATH.split(path.delimiter).includes(extra)) {
    env.PATH = extra + path.delimiter + env.PATH;
  }
  return env;
}

function exec(cmd, args, opts) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    env: opts.env || process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeoutMs || 180000,
    windowsHide: true,
  });
  return {
    cmd: [cmd].concat(args).join(" "),
    status: r.status,
    signal: r.signal,
    timedOut: Boolean(r.error && r.error.code === "ETIMEDOUT"),
    spawnError: r.error ? String(r.error.message) : null,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  };
}

function tail(text, n) {
  const lines = String(text || "").split(/\r?\n/).filter(Boolean);
  return lines.slice(-n).join("\n");
}

function statInfo(p) {
  try {
    const s = fs.statSync(p);
    return { path: p, bytes: s.size, mtime: s.mtime.toISOString() };
  } catch (_) {
    return null;
  }
}

// ------------------------------------------------------------------ build
function build(flags) {
  const cfg = loadConfig(flags);
  const mode = flags.operationMode !== undefined ? Number(flags.operationMode) : cfg.operation_mode;
  const wanted = [];
  if (flags.sidecar || flags.all) wanted.push("sidecar");
  if (flags.web || flags.all) wanted.push("web");
  if (flags.shell || flags.all) wanted.push("shell");
  if (!wanted.length || flags.all) wanted.push("sidecar", "web", "shell");
  const steps = [...new Set(wanted)];
  const env = withCargoPath();
  const commands = [];
  const executed = [];
  const artifacts = [];

  for (const step of steps) {
    let cmd, args, cwd = ROOT;
    if (step === "sidecar") {
      cmd = "powershell";
      args = ["-ExecutionPolicy", "Bypass", "-File", resolvePath(cfg.build_sidecar)];
    } else if (step === "web") {
      cmd = process.execPath;
      args = [resolvePath(cfg.stage_web)];
    } else {
      cmd = process.platform === "win32" ? "cargo.exe" : "cargo";
      args = ["build", "--release"];
      cwd = path.join(ROOT, "src-tauri");
    }
    commands.push({ step, command: [cmd].concat(args).join(" ") });
    if (mode === 2) continue;
    const r = exec(cmd, args, { cwd, env, timeoutMs: flags.timeoutMs || 600000 });
    executed.push({ step, status: r.status, timedOut: r.timedOut });
    if (r.status !== 0 || r.timedOut || r.spawnError) {
      throw new SkillError("build_failed", `${step} 构建失败`, {
        step,
        status: r.status,
        timedOut: r.timedOut,
        spawnError: r.spawnError,
        stderr_tail: tail(r.stderr, 30),
        stdout_tail: tail(r.stdout, 20),
      });
    }
  }

  if (mode !== 2) {
    const binariesDir = path.join(ROOT, "src-tauri/binaries");
    const sidecars = fs.existsSync(binariesDir)
      ? fs.readdirSync(binariesDir).filter((n) => /^esp32sim-.*\.exe$/.test(n)).map((n) => path.join(binariesDir, n))
      : [];
    const seen = new Set();
    for (const p of [
      cfg.sidecar,
      ...sidecars,
      "src-tauri/target/release/esp32sim-desktop.exe",
      "dist/portable/esp32sim.exe",
      "dist/portable/esp32sim-desktop.exe",
      "resources/web/run.html",
    ]) {
      const full = resolvePath(p);
      if (seen.has(full)) continue;
      seen.add(full);
      const info = statInfo(full);
      if (info) artifacts.push(info);
    }
  }
  ok("build", mode === 2 ? `预览 ${steps.join(" → ")}（未执行）` : `构建完成：${steps.join(" → ")}`, {
    details: { steps, commands, operation_mode: mode, executed },
    artifacts,
    next_actions: mode === 2 ? ["把 operation_mode 设为 1 后重新执行"] : ["run", "panel-shot"],
  });
}

// ------------------------------------------------------------------ run
function collectRunArgs(flags, cfg, forcePng) {
  let config = {};
  if (flags.config) {
    config = JSON.parse(fs.readFileSync(resolvePath(flags.config), "utf8"));
  }
  const pick = (name, configKey, fallback) =>
    flags[name] !== undefined ? flags[name] : config[configKey] !== undefined ? config[configKey] : fallback;

  const exe = resolvePath(flags.exe || cfg.sidecar);
  if (!fs.existsSync(exe)) throw new SkillError("sidecar_missing", `sidecar 不存在：${exe}`);

  const devices = config.devices || [];
  const specs = asArray(flags.device).concat(specsFromDevices(devices));
  const board = pick("board", "board", specs.length ? "custom" : "none");
  const args = [
    "--chip", String(pick("chip", "chip", "s3")),
    "--board", String(board),
    "--boot", String(flags.boot || "rom"),
    "--max-seconds", String(flags.maxSeconds || cfg.max_seconds),
  ];
  if (specs.length) for (const s of specs) args.push("--device", String(s));
  for (const [flag, key] of [["bootloader", "bootloader"], ["ptable", "ptable"], ["app", "app"]]) {
    const v = pick(flag, key, undefined);
    if (v) args.push("--" + flag, resolvePath(String(v)));
  }
  const localRom = fs.existsSync(path.join(ROOT, "roms/esp32s3_rev0_rom.elf")) ? "roms/esp32s3_rev0_rom.elf" : undefined;
  const rom = pick("rom", "romPath", localRom);
  if (rom) args.push("--rom", resolvePath(String(rom)));
  for (const elf of asArray(pick("elf", "elf", undefined))) args.push("--elf", resolvePath(String(elf)));
  if (flags.flashImage) args.push("--flash-image", resolvePath(String(flags.flashImage)));
  const flashMb = pick("flashMb", "flashMb", undefined);
  const psramMb = pick("psramMb", "psramMb", undefined);
  if (flashMb) args.push("--flash-mb", String(flashMb));
  if (psramMb) args.push("--psram-mb", String(psramMb));
  if (flags.console) args.push("--console", String(flags.console));
  if (flags.imuMotion) args.push("--imu-motion", String(flags.imuMotion));
  for (const d of asArray(flags.debug)) args.push("--debug", String(d));
  if (flags.vcd) args.push("--vcd", resolvePath(String(flags.vcd)));
  if (flags.wifi) args.push("--wifi", String(flags.wifi));
  if (flags.script) args.push("--script", resolvePath(String(flags.script)));

  const buslog = flags.buslog || config.buslog;
  if (buslog) {
    const p = resolvePath(String(buslog));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    args.push("--buslog", p);
  }
  const png = forcePng || flags.tftPng || config.tftPng;
  if (png) {
    const p = resolvePath(String(png));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    args.push("--tft-png", p);
  }
  if (!flags.dump) args.push("--no-dump");
  return { exe, args, specs, buslog: buslog ? resolvePath(String(buslog)) : null, png: png ? resolvePath(String(png)) : null };
}

function parseRunOutput(stdout, stderr) {
  const all = stdout + "\n" + stderr;
  const panels = [...all.matchAll(/\[emu\] panel:\s+(\d+)\s+frames,\s+(\d+)x(\d+)/g)];
  const last = panels.length ? panels[panels.length - 1] : null;
  const panicked = /panicked at|assertion failed|ESP_ERROR_CHECK failed/i.test(stderr);
  return {
    panel: last ? { frames: Number(last[1]), width: Number(last[2]), height: Number(last[3]) } : null,
    foundControllers: (all.match(/found a controller at 0x[0-9a-fA-F]+/g) || []).length,
    notFound: (all.match(/nothing at 0x[0-9a-fA-F]+/g) || []).length,
    panicked,
  };
}

function doRun(flags, forcePng) {
  const cfg = loadConfig(flags);
  const { exe, args, specs, buslog, png } = collectRunArgs(flags, cfg, forcePng);
  const r = exec(exe, args, { timeoutMs: flags.timeoutMs || 180000 });
  const parsed = parseRunOutput(r.stdout, r.stderr);
  const failed = r.status !== 0 || r.timedOut || r.spawnError || parsed.panicked;
  const artifacts = [];
  if (buslog && fs.existsSync(buslog)) artifacts.push(statInfo(buslog));
  if (png && fs.existsSync(png)) artifacts.push(statInfo(png));
  const summary = failed
    ? `仿真失败（exit=${r.status}${r.timedOut ? ", 超时" : ""}）`
    : parsed.panel
      ? `面板 ${parsed.panel.frames} 帧 ${parsed.panel.width}x${parsed.panel.height}`
      : "仿真完成（无面板器件）";
  const result = {
    status: failed ? "error" : "ok",
    action: forcePng ? "panel-shot" : "run",
    summary,
    details: {
      command: [exe].concat(args).join(" "),
      devices: specs,
      exit_code: r.status,
      signal: r.signal,
      timed_out: r.timedOut,
      spawn_error: r.spawnError,
      stdout_tail: tail(r.stdout, 20),
      stderr_tail: tail(r.stderr, 20),
      parsed,
    },
    artifacts: artifacts.filter(Boolean),
    next_actions: [],
  };
  if (!failed && parsed.panel && parsed.panel.frames === 0 && specs.some((s) => /co5300|sh1106|aht20/.test(s))) {
    result.next_actions.push("buslog：核对总线事务；若面板 0 帧，检查 SCLK/CS 或 SDA/SCL 是否连对");
  }
  if (!failed && buslog) result.next_actions.push(`buslog --file ${buslog}`);
  return result;
}

function run(flags) {
  emit(doRun(flags, false));
}

// ------------------------------------------------------------------ panel-shot
function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.length < 24 || b.toString("ascii", 1, 4) !== "PNG") return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function panelShot(flags) {
  if (!flags.tftPng) throw new SkillError("missing_tft_png", "panel-shot 需要 --tft-png <输出文件>");
  const result = doRun(flags, String(flags.tftPng));
  if (result.status !== "ok") {
    emit(result);
    return;
  }
  const p = resolvePath(String(flags.tftPng));
  const size = pngSize(p);
  const siblings = fs.existsSync(path.dirname(p))
    ? fs.readdirSync(path.dirname(p)).filter((n) => n.startsWith(path.basename(p, ".png")) && n.endsWith(".png"))
    : [];
  emit({
    status: "ok",
    action: "panel-shot",
    summary: size ? `面板截图 ${size.width}x${size.height}` : "面板截图已保存",
    details: Object.assign({}, result.details, { images: siblings.map((n) => path.join(path.dirname(p), n)) }),
    artifacts: [statInfo(p)].filter(Boolean),
    next_actions: ["用图像查看工具目视检查截图内容"],
  });
}

// ------------------------------------------------------------------ buslog
function buslog(flags) {
  const file = resolvePath(flags.file || path.join(STATE_DIR, "last-buslog.txt"));
  if (!fs.existsSync(file)) throw new SkillError("buslog_missing", `找不到总线日志：${file}`);
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  const transactions = [];
  let gpioEdges = 0;
  let idleGaps = 0;
  let declared = 0;
  const pins = new Set();
  for (const line of lines) {
    const edge = /^\d+\.\d+\s+(.+)$/.exec(line);
    if (edge && /g\d+[v^]/.test(edge[1])) {
      gpioEdges++;
      for (const m of edge[1].matchAll(/g(\d+)[v^]/g)) pins.add(Number(m[1]));
      continue;
    }
    if (/idle/.test(line)) idleGaps++;
    const declaredM = /\[buslog\]\s+gpspi:\s+(\d+)\s+master transactions/.exec(line);
    if (declaredM) declared = Number(declaredM[1]);
    const tx = /^\s*\[buslog\]\s+#(\d+)\s+host(\d+)\s+(.*)$/.exec(line);
    if (tx) transactions.push({ index: Number(tx[1]), host: Number(tx[2]), bytes: tx[3].trim() });
  }

  const i2c = [];
  if (flags.i2c) {
    const i2cFile = resolvePath(flags.i2c);
    if (!fs.existsSync(i2cFile)) throw new SkillError("i2c_log_missing", `找不到 I2C 日志：${i2cFile}`);
    let current = null;
    for (const line of fs.readFileSync(i2cFile, "utf8").split(/\r?\n/)) {
      const start = /\[i2c\] start addr (0x[0-9a-fA-F]+) read=(true|false)/.exec(line);
      if (start) {
        current = { address: start[1], read: start[2] === "true", bytes: [] };
        i2c.push(current);
        continue;
      }
      const byte = /\[i2c\]\s+(?:write|read)\s+(0x[0-9a-fA-F]+)/.exec(line);
      if (byte && current) current.bytes.push(byte[1]);
    }
  }

  const tailN = Number(flags.tail || 12);
  ok("buslog", `GPIO 边沿 ${gpioEdges}，GPSPI 事务 ${declared || transactions.length}${i2c.length ? `，I2C ${i2c.length}` : ""}`, {
    details: {
      file,
      gpio_pins: [...pins].sort((a, b) => a - b),
      transactions: transactions.slice(-tailN),
      i2c_transactions: i2c.slice(-tailN),
    },
    metrics: {
      gpio_edges: gpioEdges,
      idle_gaps: idleGaps,
      gpspi_transactions: declared || transactions.length,
      decoded_transactions: transactions.length,
      i2c_transactions: i2c.length,
    },
    artifacts: [statInfo(file)],
    next_actions: transactions.length ? ["按事务字节核对器件初始化序列"] : ["run --buslog 生成日志"],
  });
}

// ------------------------------------------------------------------ dispatch
const [action, ...rest] = process.argv.slice(2);
const { flags } = parseArgs(rest);
try {
  if (action === "build") build(flags);
  else if (action === "run") run(flags);
  else if (action === "panel-shot") panelShot(flags);
  else if (action === "buslog") buslog(flags);
  else throw new SkillError("unknown_action", "未知子命令，可选：build | run | buslog | panel-shot");
} catch (e) {
  fail(action || "none", e instanceof SkillError ? e : new SkillError("internal_error", e.message, { stack: e.stack }));
}
