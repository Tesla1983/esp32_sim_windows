use notify::Watcher;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// 只保留一个 sidecar 句柄：同一时刻只允许一个仿真进程，避免端口与日志交错。
struct SidecarState(Mutex<Option<CommandChild>>);

/// build 目录监视器；drop 即停止监听。
struct WatchState(Mutex<Option<notify::RecommendedWatcher>>);

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunConfig {
    chip: String,
    board: String,
    #[serde(default)]
    devices: Option<Vec<String>>,
    bootloader: String,
    ptable: String,
    app: String,
    elf: Option<String>,
    rom: Option<String>,
    flash_mb: Option<u32>,
    psram_mb: Option<u32>,
    wifi_ssid: Option<String>,
    wifi_psk: Option<String>,
    tft_png: Option<String>,
    wav: Option<String>,
    vcd: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildFiles {
    bootloader: Option<String>,
    ptable: Option<String>,
    app: Option<String>,
    elf: Option<String>,
}

fn pick_file(dir: &Path, rel: &str) -> Option<String> {
    let p = dir.join(rel);
    if p.is_file() {
        Some(p.to_string_lossy().to_string())
    } else {
        None
    }
}

/// 在 build 目录里按 ESP-IDF / PlatformIO 的常见布局找三件套与 ELF。
fn scan_build_dir(dir: &Path) -> BuildFiles {
    let bootloader = pick_file(dir, "bootloader/bootloader.bin");
    let ptable = pick_file(dir, "partition_table/partition-table.bin")
        .or_else(|| pick_file(dir, "partition_table/partition_table.bin"));
    let mut app = None;
    let mut elf = None;
    if let Ok(entries) = std::fs::read_dir(dir) {
        let mut bins: Vec<PathBuf> = Vec::new();
        let mut elfs: Vec<PathBuf> = Vec::new();
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            match p.extension().and_then(|s| s.to_str()) {
                Some("bin") => bins.push(p),
                Some("elf") => elfs.push(p),
                _ => {}
            }
        }
        bins.retain(|p| {
            let n = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            n != "bootloader.bin" && n != "partition-table.bin" && n != "partition_table.bin"
        });
        bins.sort_by_key(|p| std::cmp::Reverse(p.metadata().map(|m| m.len()).unwrap_or(0)));
        app = bins.first().map(|p| p.to_string_lossy().to_string());
        elfs.sort_by_key(|p| std::cmp::Reverse(p.metadata().map(|m| m.len()).unwrap_or(0)));
        elf = elfs.first().map(|p| p.to_string_lossy().to_string());
    }
    BuildFiles {
        bootloader,
        ptable,
        app,
        elf,
    }
}

fn rom_filename(chip: &str) -> Option<&'static str> {
    match chip {
        "s3" => Some("esp32s3_rev0_rom.elf"),
        "esp32" => Some("esp32_rev300_rom.elf"),
        "c3" => Some("esp32c3_rev3_rom.elf"),
        "c6" => Some("esp32c6_rev0_rom.elf"),
        "p4" => Some("esp32p4_rev0_rom.elf"),
        "s31" => Some("esp32s31_rev0_rom.elf"),
        _ => None,
    }
}

/// 依次在：显式环境变量、项目 roms/、ESP-IDF 的 esp-rom-elfs 目录里找 mask ROM。
fn find_rom(chip: &str) -> Option<String> {
    let name = rom_filename(chip)?;
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(dir) = std::env::var("ESP32SIM_ROM_DIR") {
        candidates.push(PathBuf::from(dir).join(name));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("roms")
            .join(name),
    );
    for var in ["USERPROFILE", "HOME"] {
        if let Ok(home) = std::env::var(var) {
            let base = PathBuf::from(home).join(".espressif/tools/esp-rom-elfs");
            if let Ok(entries) = std::fs::read_dir(&base) {
                for e in entries.flatten() {
                    candidates.push(e.path().join(name));
                }
            }
        }
    }
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().to_string())
}

/// sidecar 的 `--web` 会按自己的工作目录找 `web/`，所以要给它一个含 `web/` 的目录：
/// 打包后是应用资源目录，开发时是 vendor/esp32sim。
fn resolve_web_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = app.path().resource_dir() {
        if dir.join("web").is_dir() {
            return Some(dir);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("vendor")
        .join("esp32sim");
    if dev.join("web").is_dir() {
        return Some(dev);
    }
    None
}

/// 绑定 0 号端口拿一个空闲端口，随后立刻释放交给 sidecar。
fn free_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| format!("端口探测失败：{e}"))?;
    let p = l.local_addr().map_err(|e| format!("端口探测失败：{e}"))?.port();
    drop(l);
    Ok(p)
}

fn build_args(cfg: &RunConfig, port: u16) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "--chip".into(),
        cfg.chip.clone(),
        "--board".into(),
        cfg.board.clone(),
    ];
    // 裸板自由搭配：每条 "bus:addr:kind" 作为一次 --device 传给 sidecar。
    if cfg.board == "custom" {
        if let Some(devices) = cfg.devices.as_ref() {
            for spec in devices.iter().filter(|s| !s.trim().is_empty()) {
                a.push("--device".into());
                a.push(spec.trim().into());
            }
        }
    }
    a.extend([
        "--boot".into(),
        "rom".into(),
        "--bootloader".into(),
        cfg.bootloader.clone(),
        "--ptable".into(),
        cfg.ptable.clone(),
        "--app".into(),
        cfg.app.clone(),
        "--web".into(),
        port.to_string(),
    ]);
    if let Some(v) = cfg.elf.as_ref().filter(|s| !s.is_empty()) {
        a.push("--elf".into());
        a.push(v.clone());
    }
    if let Some(v) = cfg.rom.as_ref().filter(|s| !s.is_empty()) {
        a.push("--rom".into());
        a.push(v.clone());
    }
    if let Some(v) = cfg.flash_mb {
        a.push("--flash-mb".into());
        a.push(v.to_string());
    }
    if let Some(v) = cfg.psram_mb {
        a.push("--psram-mb".into());
        a.push(v.to_string());
    }
    if let Some(ssid) = cfg.wifi_ssid.as_ref().filter(|s| !s.is_empty()) {
        let psk = cfg.wifi_psk.clone().unwrap_or_default();
        a.push("--wifi".into());
        a.push(format!("ssid={ssid},psk={psk}"));
    }
    if let Some(v) = cfg.tft_png.as_ref().filter(|s| !s.is_empty()) {
        a.push("--tft-png".into());
        a.push(v.clone());
    }
    if let Some(v) = cfg.wav.as_ref().filter(|s| !s.is_empty()) {
        a.push("--wav".into());
        a.push(v.clone());
    }
    if let Some(v) = cfg.vcd.as_ref().filter(|s| !s.is_empty()) {
        a.push("--vcd".into());
        a.push(v.clone());
    }
    a
}

fn kill_sidecar(state: &SidecarState) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(child) = guard.take() {
            let _ = child.kill();
        }
    }
}

#[tauri::command]
async fn detect_build_dir(dir: String) -> Result<BuildFiles, String> {
    let p = PathBuf::from(&dir);
    if !p.is_dir() {
        return Err(format!("目录不存在：{dir}"));
    }
    Ok(scan_build_dir(&p))
}

#[tauri::command]
fn detect_rom(chip: String) -> Option<String> {
    find_rom(&chip)
}

#[tauri::command]
fn app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建数据目录：{e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

// ---- 窗口尺寸记忆 ----
// 只持久化宽高两列到 app_data_dir/window-size.json。
// 读取/解析/校验的任何失败都静默忽略，窗口保持 tauri.conf 里的默认尺寸，绝不影响启动。

const WINDOW_STATE_FILE: &str = "window-size.json";

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct WindowSize {
    width: u32,
    height: u32,
}

fn window_state_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(WINDOW_STATE_FILE))
}

/// 挡掉 0 / 损坏的极大值；负数在 u32 解析阶段就已被拒。
fn sane_window_size(w: u32, h: u32) -> bool {
    (320..=16384).contains(&w) && (240..=16384).contains(&h)
}

/// 启动时应用上次的窗口尺寸；任何异常都静默忽略，使用配置默认值。
fn restore_window_size(app: &tauri::AppHandle) {
    let saved = window_state_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<WindowSize>(&s).ok())
        .filter(|v| sane_window_size(v.width, v.height));
    if let (Some(v), Some(win)) = (saved, app.get_webview_window("main")) {
        let _ = win.set_size(tauri::PhysicalSize {
            width: v.width,
            height: v.height,
        });
    }
}

/// 窗口关闭时保存当前尺寸；写盘失败静默忽略，不影响退出。
fn save_window_size(app: &tauri::AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let Ok(size) = win.inner_size() else {
        return;
    };
    if !sane_window_size(size.width, size.height) {
        return;
    }
    let Some(path) = window_state_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let data = WindowSize {
        width: size.width,
        height: size.height,
    };
    if let Ok(json) = serde_json::to_string(&data) {
        let _ = std::fs::write(path, json);
    }
}

#[tauri::command]
fn write_text(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("无法创建目录：{e}"))?;
    }
    std::fs::write(&path, content).map_err(|e| format!("写入失败：{e}"))
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("读取失败：{e}"))
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let target = if p.is_dir() {
        p.clone()
    } else {
        p.parent().map(|x| x.to_path_buf()).unwrap_or(p)
    };
    if !target.exists() {
        return Err(format!("路径不存在：{}", target.display()));
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("打开失败：{e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("open")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("打开失败：{e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn start_watch(
    app: tauri::AppHandle,
    state: State<'_, WatchState>,
    dir: String,
) -> Result<(), String> {
    let path = PathBuf::from(&dir);
    if !path.is_dir() {
        return Err(format!("目录不存在：{dir}"));
    }

    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = None;

    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if matches!(
                ev.kind,
                notify::EventKind::Modify(_) | notify::EventKind::Create(_)
            ) {
                let _ = tx.send(());
            }
        }
    })
    .map_err(|e| format!("无法创建目录监视：{e}"))?;
    watcher
        .watch(&path, notify::RecursiveMode::Recursive)
        .map_err(|e| format!("无法监视目录：{e}"))?;
    *guard = Some(watcher);
    drop(guard);

    std::thread::spawn(move || {
        let mut last = std::time::Instant::now() - std::time::Duration::from_secs(10);
        while rx.recv().is_ok() {
            if last.elapsed() < std::time::Duration::from_millis(700) {
                continue;
            }
            last = std::time::Instant::now();
            let _ = app.emit("build-changed", ());
        }
    });
    Ok(())
}

#[tauri::command]
fn stop_watch(state: State<'_, WatchState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
}

#[tauri::command]
async fn start_sim(
    app: tauri::AppHandle,
    state: State<'_, SidecarState>,
    cfg: RunConfig,
) -> Result<u16, String> {
    for (label, path) in [
        ("bootloader", &cfg.bootloader),
        ("partition-table", &cfg.ptable),
        ("app", &cfg.app),
    ] {
        if !Path::new(path).is_file() {
            return Err(format!("{label} 文件不存在：{path}"));
        }
    }

    let mut cfg = cfg;
    if cfg.rom.as_deref().unwrap_or("").is_empty() {
        cfg.rom = find_rom(&cfg.chip);
    }
    if cfg.rom.is_none() {
        return Err(format!(
            "找不到 {} 的 mask ROM：请把对应的 .elf 放到 roms/ 目录，或在左侧「ROM」里指定文件",
            cfg.chip
        ));
    }

    kill_sidecar(&state);
    let port = free_port()?;
    let args = build_args(&cfg, port);

    let web_root = resolve_web_root(&app).ok_or_else(|| {
        "找不到 web 资源目录：需要 resources/web（打包）或 vendor/esp32sim/web（开发）".to_string()
    })?;

    let cmd = app
        .shell()
        .sidecar("esp32sim")
        .map_err(|e| format!("找不到内嵌的 esp32sim 可执行文件：{e}"))?
        .args(args)
        .current_dir(web_root);

    let (mut rx, child) = cmd.spawn().map_err(|e| format!("启动失败：{e}"))?;
    *state.0.lock().map_err(|e| e.to_string())? = Some(child);

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            match ev {
                CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => {
                    let _ = app_handle.emit("sidecar-log", String::from_utf8_lossy(&b).to_string());
                }
                CommandEvent::Terminated(p) => {
                    let _ = app_handle.emit("sidecar-exit", p.code);
                }
                _ => {}
            }
        }
    });

    Ok(port)
}

#[tauri::command]
fn stop_sim(state: State<'_, SidecarState>) -> Result<(), String> {
    kill_sidecar(&state);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .manage(SidecarState(Mutex::new(None)))
        .manage(WatchState(Mutex::new(None)))
        .setup(|app| {
            // 窗口在 tauri.conf.json 里设为 visible:false，先定好尺寸再显示，
            // 避免「默认尺寸先闪一下、再跳到 restores 尺寸」。首次/异常时保持默认尺寸。
            restore_window_size(app.handle());
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.center();
                let _ = win.show();
                let _ = win.set_focus();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            detect_build_dir,
            detect_rom,
            app_data_dir,
            write_text,
            read_text,
            open_path,
            start_watch,
            stop_watch,
            start_sim,
            stop_sim
        ])
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { .. } => {
                    save_window_size(window.app_handle());
                }
                tauri::WindowEvent::Destroyed => {
                    if let Some(state) = window.app_handle().try_state::<SidecarState>() {
                        kill_sidecar(&state);
                    }
                    if let Some(state) = window.app_handle().try_state::<WatchState>() {
                        if let Ok(mut guard) = state.0.lock() {
                            *guard = None;
                        }
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
