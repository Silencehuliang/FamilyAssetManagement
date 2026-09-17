/// <reference types="vite/client" />

// Vite 环境类型声明。
// 作用：让 `import "./styles.css"` 这类副作用导入与 `import.meta.env` 有类型。
// 没有它，TS 7 会对 CSS 副作用导入报 TS2882。
