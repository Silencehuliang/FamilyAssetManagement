import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("#root 不存在 —— index.html 被改坏了？");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// ============================================================================
// Service Worker 注册
//
// ⚠️ 骨架阶段注册它是**安全的** —— public/sw.js 不缓存任何东西（见该文件头部说明）。
//    但**不要**因此以为离线能力已经存在了。
//
// TODO(offline-sync §7.3)：改走 workbox-window ——
//   检测到 waiting ⇒ 提示条（含「刷新不会丢失待同步记录」）
//   ⇒ 用户点击 ⇒ messageSkipWaiting() ⇒ controlling ⇒ location.reload()
//
// 🔴 三条底线（offline-sync §7.3 / frontend-ia §10.10）：
//   - **禁用**安装期无条件 skipWaiting()
//   - **不注册**在文件协议或非 HTTPS 下（SW 只在安全上下文可用）
//   - 登出 / 会话失效时 `postMessage({type:"CLEAR_RUNTIME_CACHE"})`
// ============================================================================
if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}
