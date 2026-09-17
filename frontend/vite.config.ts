import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // = pages_build_output_dir（见 frontend/wrangler.jsonc）
    outDir: "dist",
    emptyOutDir: true,

    // 产物统一落 dist/assets/ —— 与 public/_headers 的 `/assets/*` immutable 规则对应。
    // ⚠️ 改了这里就要同步改 _headers 的路径前缀。
    assetsDir: "assets",

    // 🔴 dist/ 顶层**不得出现 404.html** —— 会关闭 Pages 的 SPA 模式，前端路由全 404
    //    （deploy-topology §11.6 / §8.2）。Vite 默认不产出该文件，这里显式记住这条约束，
    //    任何后续插件（如 vite-plugin-pwa 的某些配置）都不得引入它。

    // 不用 `_redirects` 做 SPA fallback（§11.5）：`/* /index.html 200` 会把
    // 缺失的 /assets/*.js 也变成 200 HTML。SPA 回退由 Pages 的「无 404.html」隐式提供。
    rollupOptions: {
      input: "index.html",
    },
  },
});
