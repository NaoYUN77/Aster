#[cfg(desktop)]
use tauri::{
  menu::{Menu, MenuItem},
  tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
  AppHandle, Manager, WindowEvent,
};

#[cfg(desktop)]
fn restore_main_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default()
    // Token 与服务器地址存放在 Tauri store（settings.json），不写普通明文配置。
    .plugin(tauri_plugin_store::Builder::new().build())
    // 授权页交给系统默认浏览器；授权结束后不做任何关闭/跳转操作。
    .plugin(tauri_plugin_opener::init())
    // Windows 右下角原生 Toast 通知。
    .plugin(tauri_plugin_notification::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      #[cfg(desktop)]
      {
        let show_item = MenuItem::with_id(app, "show", "打开 Aster", true, None::<&str>)?;
        let quit_item = MenuItem::with_id(app, "quit", "退出 Aster", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

        let mut tray = TrayIconBuilder::with_id("main-tray")
          .menu(&menu)
          .tooltip("Aster — 后台运行中")
          .show_menu_on_left_click(false)
          .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => restore_main_window(app),
            "quit" => app.exit(0),
            _ => {}
          })
          .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
              button: MouseButton::Left,
              button_state: MouseButtonState::Up,
              ..
            } = event
            {
              restore_main_window(tray.app_handle());
            }
          });

        if let Some(icon) = app.default_window_icon().cloned() {
          tray = tray.icon(icon);
        }

        tray.build(app)?;
      }

      Ok(())
    });

  #[cfg(desktop)]
  let builder = builder.on_window_event(|window, event| {
    if window.label() == "main" {
      if let WindowEvent::CloseRequested { api, .. } = event {
        // 关闭主窗口时最小化到系统托盘，保持 SSE 连接在线以持续接收任务/监控/提醒通知。
        api.prevent_close();
        let _ = window.hide();
      }
    }
  });

  builder
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
