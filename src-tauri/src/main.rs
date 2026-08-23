// Suppress the extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // One non-window mode is dispatched before Tauri initialises: the
    // permission-prompt MCP server the CLI spawns. It must not open a window.
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
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

    mangouste_lib::run()
}
