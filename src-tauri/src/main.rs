// Suppress the extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Two non-window modes are dispatched before Tauri initialises: the
    // permission-prompt MCP server the CLI spawns, and the same server's
    // control tools on their own, for a `claude` run outside the app. Neither
    // may open a window.
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--mcp" {
            mangouste_lib::run_control_server();
            return;
        }
        if arg == "--permission-server" {
            let socket = args.next();
            // `--permission-chat <id>` follows, naming the chat this server asks
            // for. Read positionally so the order stays as written in the
            // generated MCP config.
            let chat_id = match args.next().as_deref() {
                Some("--permission-chat") => args.next(),
                _ => None,
            };
            match socket {
                Some(socket) => mangouste_lib::run_permission_server(socket, chat_id),
                None => eprintln!("--permission-server requires a socket path"),
            }
            return;
        }
    }

    disable_webkit_dmabuf_renderer();
    mangouste_lib::run()
}

/// WebKitGTK's DMA-BUF renderer leaks one `sync_file` descriptor per frame on
/// the NVIDIA driver (webkit2gtk 2.52.6-0ubuntu0.26.04.2). The web process
/// reaches its 1024 open-file limit within minutes, the driver then fails
/// fence waits with EMFILE, and the stalled GPU freezes the whole desktop, not
/// only this window. Falling back to the shared-memory renderer stops the leak.
/// Set before Tauri starts so the web process inherits it; a value already in
/// the environment wins, so `WEBKIT_DISABLE_DMABUF_RENDERER=0` re-enables it.
fn disable_webkit_dmabuf_renderer() {
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}
