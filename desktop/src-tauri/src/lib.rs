use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const MAX_PLAYLIST_ITEMS: u32 = 25;
const UPDATE_EVERY_SECS: u64 = 2 * 24 * 3600;
const ALLOWED_HOSTS: &[&str] = &[
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "www.youtu.be",
];

#[derive(Default)]
struct AppState {
    child_pid: Mutex<Option<u32>>,
    cancelled: AtomicBool,
    busy: AtomicBool,
    setup_lock: Mutex<()>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct Settings {
    out_dir: Option<String>,
    last_update: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HistoryItem {
    id: String,
    title: String,
    filename: String,
    path: String,
    format: String,
    label: String,
    bytes: Option<u64>,
    created_at: String,
    thumbnail: Option<String>,
    duration_text: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConvertRequest {
    url: String,
    format: String,
    quality: Option<u32>,
    resolution: Option<String>,
    playlist: bool,
    preview: Option<Value>,
}

// ---------- paths and small helpers ----------

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn data_dir(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("memeh-mp3"));
    let _ = fs::create_dir_all(&dir);
    dir
}

fn tools_dir(app: &AppHandle) -> PathBuf {
    let dir = data_dir(app).join("tools");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn bundled_tools_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok().map(|d| d.join("tools"))
}

fn find_tool(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let file = exe(name);
    let local = tools_dir(app).join(&file);
    if local.is_file() {
        return Some(local);
    }
    if let Some(b) = bundled_tools_dir(app) {
        let p = b.join(&file);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn iso_now() -> String {
    // RFC 3339 in UTC without extra crates.
    let secs = now_secs() as i64;
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // civil from days (Howard Hinnant)
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    if mo <= 2 {
        y += 1;
    }
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

fn rand_id() -> String {
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}{:x}", n, std::process::id())
}

fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

fn load_settings(app: &AppHandle) -> Settings {
    fs::read_to_string(data_dir(app).join("settings.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, s: &Settings) {
    if let Ok(text) = serde_json::to_string_pretty(s) {
        let _ = fs::write(data_dir(app).join("settings.json"), text);
    }
}

fn out_dir(app: &AppHandle) -> PathBuf {
    let s = load_settings(app);
    let dir = match s.out_dir {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => app
            .path()
            .download_dir()
            .or_else(|_| app.path().home_dir())
            .unwrap_or_else(|_| std::env::temp_dir())
            .join("Memeh MP3"),
    };
    let _ = fs::create_dir_all(&dir);
    dir
}

fn load_history(app: &AppHandle) -> Vec<HistoryItem> {
    fs::read_to_string(data_dir(app).join("history.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_history(app: &AppHandle, items: &[HistoryItem]) {
    if let Ok(text) = serde_json::to_string_pretty(items) {
        let _ = fs::write(data_dir(app).join("history.json"), text);
    }
}

fn valid_youtube_url(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() || trimmed.len() > 2000 {
        return None;
    }
    let mut url = tauri::Url::parse(trimmed).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    let host = url.host_str()?.to_lowercase();
    if !ALLOWED_HOSTS.contains(&host.as_str()) {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    url.set_fragment(None);
    Some(url.to_string())
}

fn format_duration(seconds: f64) -> String {
    let total = seconds.max(0.0).round() as u64;
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

// ---------- tools: download, setup, update ----------

struct ToolFile {
    name: &'static str,
    label: &'static str,
    url: String,
    zip_member: Option<&'static str>,
}

fn needed_tools() -> Vec<ToolFile> {
    let mut list = Vec::new();
    if cfg!(target_os = "windows") {
        list.push(ToolFile {
            name: "yt-dlp",
            label: "YouTube engine",
            url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe".into(),
            zip_member: None,
        });
        // yt-dlp, ffmpeg, ffprobe and qjs ship inside the installer on Windows,
        // so nothing is downloaded and run on first launch. This entry is only
        // a fallback if the bundled copy is missing.
    } else if cfg!(target_os = "macos") {
        let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "amd64" };
        let qarch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x86_64" };
        list.push(ToolFile {
            name: "yt-dlp",
            label: "YouTube engine",
            url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos".into(),
            zip_member: None,
        });
        list.push(ToolFile {
            name: "ffmpeg",
            label: "audio and video converter",
            url: format!("https://ffmpeg.martin-riedl.de/redirect/latest/macos/{arch}/release/ffmpeg.zip"),
            zip_member: Some("ffmpeg"),
        });
        list.push(ToolFile {
            name: "ffprobe",
            label: "media scanner",
            url: format!("https://ffmpeg.martin-riedl.de/redirect/latest/macos/{arch}/release/ffprobe.zip"),
            zip_member: Some("ffprobe"),
        });
        list.push(ToolFile {
            name: "qjs",
            label: "script helper",
            url: format!("https://github.com/quickjs-ng/quickjs/releases/latest/download/qjs-darwin-{qarch}"),
            zip_member: None,
        });
    } else {
        list.push(ToolFile {
            name: "yt-dlp",
            label: "YouTube engine",
            url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux".into(),
            zip_member: None,
        });
        list.push(ToolFile {
            name: "qjs",
            label: "script helper",
            url: "https://github.com/quickjs-ng/quickjs/releases/latest/download/qjs-linux-x86_64".into(),
            zip_member: None,
        });
    }
    list
}

fn tool_status(app: &AppHandle) -> Value {
    let missing: Vec<&str> = needed_tools()
        .iter()
        .filter(|t| find_tool(app, t.name).is_none())
        .map(|t| t.label)
        .collect();
    let ffmpeg_ok = find_tool(app, "ffmpeg").is_some() || cfg!(target_os = "linux");
    json!({
        "ready": missing.is_empty() && ffmpeg_ok,
        "missing": missing,
    })
}

fn http_get(url: &str) -> Result<ureq::Response, String> {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(20))
        .timeout_read(Duration::from_secs(60))
        .redirects(10)
        .user_agent("MemehMP3-desktop")
        .build()
        .get(url)
        .call()
        .map_err(|e| format!("Download failed: {e}"))
}

fn download_to(
    app: &AppHandle,
    url: &str,
    dest: &Path,
    label: &str,
    step: usize,
    steps: usize,
) -> Result<(), String> {
    let resp = http_get(url)?;
    let total: Option<u64> = resp.header("content-length").and_then(|v| v.parse().ok());
    let tmp = dest.with_extension("download");
    let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut reader = resp.into_reader();
    let mut buf = vec![0u8; 64 * 1024];
    let mut done: u64 = 0;
    let mut last_emit = 0u64;
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("Download interrupted: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        if done - last_emit > 512 * 1024 {
            last_emit = done;
            let pct = total.map(|t| (done as f64 / t as f64) * 100.0);
            let _ = app.emit(
                "setup",
                json!({"label": label, "step": step, "steps": steps, "percent": pct, "mb": done as f64 / 1048576.0}),
            );
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    let _ = fs::remove_file(dest);
    fs::rename(&tmp, dest).map_err(|e| e.to_string())?;
    Ok(())
}

fn make_executable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o755));
        #[cfg(target_os = "macos")]
        {
            let _ = Command::new("xattr")
                .args(["-d", "com.apple.quarantine"])
                .arg(path)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

fn install_tool(app: &AppHandle, t: &ToolFile, step: usize, steps: usize) -> Result<(), String> {
    let dir = tools_dir(app);
    let dest = dir.join(exe(t.name));
    match t.zip_member {
        None => download_to(app, &t.url, &dest, t.label, step, steps)?,
        Some(member) => {
            let zip_path = dir.join(format!("{}.zip", t.name));
            download_to(app, &t.url, &zip_path, t.label, step, steps)?;
            let f = fs::File::open(&zip_path).map_err(|e| e.to_string())?;
            let mut archive = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
            let mut found = false;
            for i in 0..archive.len() {
                let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
                let name = entry.name().replace('\\', "/");
                let base = name.rsplit('/').next().unwrap_or("");
                if base == member || base == format!("{member}.exe") {
                    let tmp = dest.with_extension("unzip");
                    let mut out = fs::File::create(&tmp).map_err(|e| e.to_string())?;
                    std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
                    drop(out);
                    let _ = fs::remove_file(&dest);
                    fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
                    found = true;
                    break;
                }
            }
            let _ = fs::remove_file(&zip_path);
            if !found {
                return Err(format!("Could not find {member} in the download"));
            }
        }
    }
    make_executable(&dest);
    Ok(())
}

fn run_setup(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let _guard = state.setup_lock.lock().map_err(|_| "busy".to_string())?;
    let todo: Vec<ToolFile> = needed_tools()
        .into_iter()
        .filter(|t| find_tool(app, t.name).is_none())
        .collect();
    let steps = todo.len();
    for (i, t) in todo.iter().enumerate() {
        let _ = app.emit(
            "setup",
            json!({"label": t.label, "step": i + 1, "steps": steps, "percent": 0}),
        );
        install_tool(app, t, i + 1, steps)?;
    }
    if steps > 0 {
        let mut s = load_settings(app);
        s.last_update = Some(now_secs());
        save_settings(app, &s);
    }
    let _ = app.emit("setup", json!({"done": true}));
    Ok(())
}

fn maybe_update_engine(app: AppHandle) {
    std::thread::spawn(move || {
        let mut s = load_settings(&app);
        let Some(last) = s.last_update else {
            // Fresh install: the engine that shipped with the app is new enough.
            s.last_update = Some(now_secs());
            save_settings(&app, &s);
            return;
        };
        if now_secs().saturating_sub(last) <= UPDATE_EVERY_SECS {
            return;
        }
        let state = app.state::<AppState>();
        if state.busy.load(Ordering::SeqCst) {
            return;
        }
        // Update a private copy so installs in read only folders still update.
        let local = tools_dir(&app).join(exe("yt-dlp"));
        if !local.is_file() {
            if let Some(bundled) = find_tool(&app, "yt-dlp") {
                if fs::copy(&bundled, &local).is_err() {
                    return;
                }
            }
        }
        if let Some(yt) = Some(local).filter(|p| p.is_file()) {
            let ok = hidden(Command::new(&yt).arg("-U"))
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|st| st.success())
                .unwrap_or(false);
            if ok {
                s.last_update = Some(now_secs());
                save_settings(&app, &s);
            }
        }
    });
}

// ---------- yt-dlp runner ----------

fn base_args(app: &AppHandle) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    if let Some(ff) = find_tool(app, "ffmpeg") {
        args.push("--ffmpeg-location".into());
        args.push(ff.parent().unwrap_or(Path::new(".")).to_string_lossy().into_owned());
    }
    if let Some(qjs) = find_tool(app, "qjs") {
        args.push("--js-runtimes".into());
        args.push(format!("quickjs:{}", qjs.to_string_lossy()));
    }
    args.push("--no-warnings".into());
    args
}

fn yt_command(app: &AppHandle) -> Result<Command, String> {
    let yt = find_tool(app, "yt-dlp").ok_or("The YouTube engine is not installed yet.")?;
    let mut cmd = Command::new(yt);
    hidden(&mut cmd);
    cmd.env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null());
    Ok(cmd)
}

fn tidy_error(text: &str) -> String {
    let lines: Vec<String> = text
        .lines()
        .map(|l| l.trim().trim_start_matches("ERROR:").trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    let keys = [
        "private", "unavailable", "copyright", "sign in", "age", "removed", "not a valid",
        "unsupported", "http error", "video", "playlist", "geo", "region",
    ];
    let pick = lines
        .iter()
        .rev()
        .find(|l| {
            let low = l.to_lowercase();
            keys.iter().any(|k| low.contains(k))
        })
        .or_else(|| lines.last())
        .cloned()
        .unwrap_or_else(|| "Something went wrong talking to YouTube.".into());
    pick.chars().take(400).collect()
}

fn pick_thumbnail(info: &Value) -> Option<String> {
    if let Some(t) = info.get("thumbnail").and_then(|v| v.as_str()) {
        return Some(t.to_string());
    }
    info.get("thumbnails")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter()
                .max_by_key(|t| t.get("width").and_then(|w| w.as_u64()).unwrap_or(0))
                .and_then(|t| t.get("url").and_then(|u| u.as_str()).map(String::from))
        })
}

fn summarize(info: &Value, playlist: bool) -> Value {
    let s = |k: &str| info.get(k).and_then(|v| v.as_str()).map(String::from);
    if playlist || s("_type").as_deref() == Some("playlist") {
        let entries: Vec<&Value> = info
            .get("entries")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter(|e| !e.is_null()).collect())
            .unwrap_or_default();
        let first = entries.first().cloned().cloned().unwrap_or(Value::Null);
        let count = entries.len().min(MAX_PLAYLIST_ITEMS as usize);
        return json!({
            "type": "playlist",
            "title": s("title").unwrap_or_else(|| "Playlist".into()),
            "thumbnail": pick_thumbnail(info).or_else(|| pick_thumbnail(&first)),
            "durationText": if count > 0 { Some(format!("{count} items")) } else { None },
            "uploader": s("uploader").or_else(|| s("channel")),
            "itemCount": count,
        });
    }
    let dur = info.get("duration").and_then(|v| v.as_f64());
    json!({
        "type": "video",
        "title": s("title").unwrap_or_else(|| "YouTube video".into()),
        "thumbnail": pick_thumbnail(info),
        "duration": dur,
        "durationText": dur.map(format_duration),
        "uploader": s("uploader").or_else(|| s("channel")),
        "itemCount": 1,
    })
}

fn video_format(res: &str) -> String {
    if res == "best" {
        return "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best".into();
    }
    let h: u32 = res.parse().unwrap_or(720);
    format!("bestvideo[height<={h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<={h}]+bestaudio/best[height<={h}]/best")
}

fn quality_label(req: &ConvertRequest) -> String {
    if req.format == "mp4" {
        let r = req.resolution.clone().unwrap_or_else(|| "720".into());
        if r == "best" {
            "Best MP4".into()
        } else {
            format!("{r}p MP4")
        }
    } else {
        format!("{} kbps", req.quality.unwrap_or(192))
    }
}

fn collect_outputs(dir: &Path, ext: &str, out: &mut Vec<PathBuf>) {
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                collect_outputs(&p, ext, out);
            } else if p
                .extension()
                .map(|x| x.to_string_lossy().eq_ignore_ascii_case(ext))
                .unwrap_or(false)
            {
                out.push(p);
            }
        }
    }
}

fn unique_dest(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let p = Path::new(name);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = p.extension().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    for i in 2..1000 {
        let cand = dir.join(format!("{stem} ({i}).{ext}"));
        if !cand.exists() {
            return cand;
        }
    }
    dir.join(format!("{stem} {}.{ext}", rand_id()))
}

fn move_file(from: &Path, to: &Path) -> std::io::Result<()> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    fs::copy(from, to)?;
    fs::remove_file(from)
}

fn emit_job(app: &AppHandle, payload: Value) {
    let _ = app.emit("job", payload);
}

fn parse_line(app: &AppHandle, line: &str, format: &str) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    if let Some(rest) = line.find("Downloading item ").map(|i| &line[i + 17..]) {
        let parts: Vec<&str> = rest.split_whitespace().collect();
        if parts.len() >= 3 {
            emit_job(app, json!({"type": "status", "message": format!("Item {} of {}", parts[0], parts[2])}));
        }
    }
    if line.starts_with("[download]") {
        if let Some(pct_end) = line.find('%') {
            let start = line[..pct_end]
                .rfind(|c: char| !(c.is_ascii_digit() || c == '.'))
                .map(|i| i + 1)
                .unwrap_or(0);
            if let Ok(pct) = line[start..pct_end].parse::<f64>() {
                let speed = line.split(" at ").nth(1).and_then(|s| s.split_whitespace().next()).map(String::from);
                let eta = line.split("ETA ").nth(1).and_then(|s| s.split_whitespace().next()).map(String::from);
                emit_job(
                    app,
                    json!({"type": "progress", "percent": pct.clamp(0.0, 100.0),
                        "speed": speed.filter(|s| s != "Unknown"),
                        "eta": eta.filter(|s| s != "Unknown"), "format": format}),
                );
            }
        }
    } else if line.starts_with("[ExtractAudio]") {
        emit_job(app, json!({"type": "status", "message": "Converting to MP3"}));
    } else if line.starts_with("[Merger]") || line.starts_with("[VideoRemuxer]") || line.contains("Merging formats") {
        emit_job(app, json!({"type": "status", "message": "Merging MP4"}));
    } else if line.starts_with("[EmbedThumbnail]") || line.starts_with("[Metadata]") {
        emit_job(app, json!({"type": "status", "message": "Adding artwork and tags"}));
    }
}

fn spawn_reader<R: Read + Send + 'static>(
    app: AppHandle,
    stream: R,
    format: String,
    log: Arc<Mutex<String>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let text = String::from_utf8_lossy(&buf).into_owned();
                    for part in text.split('\r') {
                        parse_line(&app, part, &format);
                    }
                    if let Ok(mut l) = log.lock() {
                        l.push_str(&text);
                        if l.len() > 16000 {
                            let cut = l.len() - 8000;
                            let idx = (cut..l.len()).find(|i| l.is_char_boundary(*i)).unwrap_or(0);
                            *l = l[idx..].to_string();
                        }
                    }
                }
            }
        }
    })
}

fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = hidden(&mut Command::new("taskkill"))
            .args(["/pid", &pid.to_string(), "/t", "/f"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(unix)]
    {
        let _ = Command::new("pkill").args(["-TERM", "-P", &pid.to_string()]).status();
        let _ = Command::new("kill").args(["-TERM", &pid.to_string()]).status();
    }
}

fn do_convert(app: &AppHandle, req: ConvertRequest, url: String) -> Result<Vec<HistoryItem>, String> {
    let state = app.state::<AppState>();
    let job_id = rand_id();
    let work = data_dir(app).join("work").join(&job_id);
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let is_mp4 = req.format == "mp4";
    let template = if req.playlist {
        "%(playlist_index)02d %(title).150B.%(ext)s"
    } else {
        "%(title).150B.%(ext)s"
    };

    let mut args = base_args(app);
    args.extend(
        [
            "--newline", "--progress", "--no-overwrites", "--windows-filenames", "--embed-metadata",
            "--embed-thumbnail", "--convert-thumbnails", "jpg", "-P",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    args.push(work.to_string_lossy().into_owned());
    args.push("-o".into());
    args.push(template.into());
    if is_mp4 {
        let res = req.resolution.clone().unwrap_or_else(|| "720".into());
        args.extend(["-f".into(), video_format(&res), "--merge-output-format".into(), "mp4".into(), "--remux-video".into(), "mp4".into()]);
    } else {
        let q = req.quality.unwrap_or(192).clamp(64, 320);
        args.extend(["-x".into(), "--audio-format".into(), "mp3".into(), "--audio-quality".into(), format!("{q}K")]);
    }
    if req.playlist {
        args.extend(["--yes-playlist".into(), "--playlist-end".into(), MAX_PLAYLIST_ITEMS.to_string()]);
    } else {
        args.push("--no-playlist".into());
    }
    args.push("--".into());
    args.push(url.clone());

    emit_job(app, json!({"type": "status", "message": "Starting download"}));
    let mut child = yt_command(app)?
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start the YouTube engine: {e}"))?;
    *state.child_pid.lock().unwrap() = Some(child.id());
    let log = Arc::new(Mutex::new(String::new()));
    let fmt = req.format.clone();
    let h1 = spawn_reader(app.clone(), child.stdout.take().unwrap(), fmt.clone(), log.clone());
    let h2 = spawn_reader(app.clone(), child.stderr.take().unwrap(), fmt, log.clone());
    let status = child.wait().map_err(|e| e.to_string())?;
    let _ = h1.join();
    let _ = h2.join();
    *state.child_pid.lock().unwrap() = None;

    if state.cancelled.load(Ordering::SeqCst) {
        let _ = fs::remove_dir_all(&work);
        return Err("Conversion cancelled.".into());
    }
    let ext = if is_mp4 { "mp4" } else { "mp3" };
    let mut files = Vec::new();
    collect_outputs(&work, ext, &mut files);
    if files.is_empty() {
        let text = log.lock().map(|l| l.clone()).unwrap_or_default();
        let _ = fs::remove_dir_all(&work);
        return Err(if !status.success() {
            tidy_error(&text)
        } else if is_mp4 {
            "Download finished, but no MP4 file was created.".into()
        } else {
            "Conversion finished, but no MP3 file was created.".into()
        });
    }
    files.sort();
    let dest_dir = out_dir(app);
    let preview = req.preview.clone().unwrap_or(Value::Null);
    let thumb = preview.get("thumbnail").and_then(|v| v.as_str()).map(String::from);
    let dur = if preview.get("type").and_then(|v| v.as_str()) == Some("video") {
        preview.get("durationText").and_then(|v| v.as_str()).map(String::from)
    } else {
        None
    };
    let label = quality_label(&req);
    let mut items = Vec::new();
    for f in files {
        let name = f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let dest = unique_dest(&dest_dir, &name);
        move_file(&f, &dest).map_err(|e| format!("Could not save the file: {e}"))?;
        let filename = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let title = Path::new(&filename)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        items.push(HistoryItem {
            id: rand_id(),
            title,
            filename,
            path: dest.to_string_lossy().into_owned(),
            format: req.format.clone(),
            label: label.clone(),
            bytes: fs::metadata(&dest).ok().map(|m| m.len()),
            created_at: iso_now(),
            thumbnail: thumb.clone(),
            duration_text: dur.clone(),
        });
        std::thread::sleep(Duration::from_millis(2));
    }
    let _ = fs::remove_dir_all(&work);
    let mut hist = load_history(app);
    for it in items.iter().rev() {
        hist.insert(0, it.clone());
    }
    hist.truncate(60);
    save_history(app, &hist);
    Ok(items)
}

// ---------- commands ----------

#[tauri::command]
fn get_state(app: AppHandle) -> Value {
    json!({
        "tools": tool_status(&app),
        "outDir": out_dir(&app).to_string_lossy(),
        "platform": std::env::consts::OS,
    })
}

#[tauri::command]
async fn setup_tools(app: AppHandle) -> Result<Value, String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app2.state::<AppState>();
        run_setup(&app2, &state)
    })
    .await
    .map_err(|e| e.to_string())??;
    maybe_update_engine(app.clone());
    Ok(tool_status(&app))
}

#[tauri::command]
async fn preview(app: AppHandle, url: String, playlist: bool) -> Result<Value, String> {
    let url = valid_youtube_url(&url).ok_or("Paste a valid YouTube link (youtube.com or youtu.be).")?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut args = base_args(&app);
        args.extend(["--dump-single-json".into(), "--skip-download".into()]);
        if playlist {
            args.extend(["--yes-playlist".into(), "--playlist-end".into(), MAX_PLAYLIST_ITEMS.to_string(), "--flat-playlist".into()]);
        } else {
            args.push("--no-playlist".into());
        }
        args.push("--".into());
        args.push(url);
        let out = yt_command(&app)?
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| format!("Could not start the YouTube engine: {e}"))?;
        if !out.status.success() {
            return Err(tidy_error(&String::from_utf8_lossy(&out.stderr)));
        }
        let info: Value = serde_json::from_slice(&out.stdout).map_err(|_| "YouTube sent back something unexpected.".to_string())?;
        Ok(summarize(&info, playlist))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn convert(app: AppHandle, state: State<'_, AppState>, req: ConvertRequest) -> Result<(), String> {
    let url = valid_youtube_url(&req.url).ok_or("Paste a valid YouTube link (youtube.com or youtu.be).")?;
    if req.format != "mp3" && req.format != "mp4" {
        return Err("Pick MP3 or MP4.".into());
    }
    if state.busy.swap(true, Ordering::SeqCst) {
        return Err("A download is already running.".into());
    }
    state.cancelled.store(false, Ordering::SeqCst);
    std::thread::spawn(move || {
        let result = do_convert(&app, req, url);
        match result {
            Ok(items) => emit_job(&app, json!({"type": "done", "files": items})),
            Err(msg) => emit_job(&app, json!({"type": "error", "message": msg})),
        }
        app.state::<AppState>().busy.store(false, Ordering::SeqCst);
    });
    Ok(())
}

#[tauri::command]
fn cancel(state: State<'_, AppState>) {
    state.cancelled.store(true, Ordering::SeqCst);
    if let Some(pid) = *state.child_pid.lock().unwrap() {
        kill_tree(pid);
    }
}

#[tauri::command]
fn history(app: AppHandle) -> Vec<Value> {
    load_history(&app)
        .into_iter()
        .map(|h| {
            let exists = Path::new(&h.path).is_file();
            let mut v = serde_json::to_value(&h).unwrap_or(Value::Null);
            v["exists"] = json!(exists);
            v
        })
        .collect()
}

#[tauri::command]
fn remove_history(app: AppHandle, id: String) {
    let mut h = load_history(&app);
    h.retain(|i| i.id != id);
    save_history(&app, &h);
}

#[tauri::command]
fn open_folder(app: AppHandle) -> Result<(), String> {
    let dir = out_dir(&app);
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal_file(app: AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return open_folder(app);
    }
    app.opener().reveal_item_in_dir(p).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_file(app: AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err("That file was moved or deleted.".into());
    }
    app.opener()
        .open_path(p.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Result<String, String> {
    let current = out_dir(&app);
    let picked = app
        .dialog()
        .file()
        .set_title("Where should Memeh MP3 save files?")
        .set_directory(&current)
        .blocking_pick_folder();
    if let Some(fp) = picked {
        if let Ok(path) = fp.into_path() {
            let mut s = load_settings(&app);
            s.out_dir = Some(path.to_string_lossy().into_owned());
            save_settings(&app, &s);
        }
    }
    Ok(out_dir(&app).to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            // Clean up any half finished jobs from a previous run.
            let _ = fs::remove_dir_all(data_dir(&handle).join("work"));
            if tool_status(&handle)["ready"].as_bool().unwrap_or(false) {
                maybe_update_engine(handle);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            setup_tools,
            preview,
            convert,
            cancel,
            history,
            remove_history,
            open_folder,
            reveal_file,
            open_file,
            pick_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running Memeh MP3");
}
