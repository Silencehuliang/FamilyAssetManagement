#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
骨架校验 —— 把「部署拓扑契约里靠人眼看的条款」变成机器断言。

为什么要有它：deploy-topology.md §13.4 自陈「本文件与 migrations/、CONTEXT.md、
四份契约之间**没有编译期或脚本级校验**，改动任一侧需人工比对」。
本脚本把那句话里的**配置那半边**补上 —— 至少以下这些不再靠人眼：

    §11.1 frontend 配置不得有 main
    §11.2 frontend 配置不得有 secrets
    §11.4 同一目录不得并存多份 wrangler 配置文件
    §11.5 不得写 _redirects
    §11.6 dist/ 顶层不得有 404.html
    §2.3  Worker 侧必填 name / main / compatibility_date / triggers.crons
    §3.1  两处 database_id 必须一致
    §3.2  只有 cron-worker 声明 migrations_dir
    §6.2  _routes.json 收窄到 /api/*；_headers 三段且不碰 /api/*
    #6    四条 cron 表达式，且与 src/index.ts 的 DISPATCH 表**键集合相等**
    #10   manifest.display 必须是 standalone（离线能力硬门禁）

用法：
    python docs/verification/skeleton-check.py

⚠️ 本脚本**不联网、不部署、不需要凭据**，只读仓库里的文件。
   E 组（构建产物）在未跑过 `npm run build` 时会标 SKIP，不算失败。
"""

from __future__ import annotations

import io
import json
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FRONTEND = os.path.join(REPO, "frontend")
CRON = os.path.join(REPO, "cron-worker")

_pass = 0
_fail = 0
_skip = 0
_lines: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> bool:
    global _pass, _fail
    if ok:
        _pass += 1
        _lines.append("  PASS  %s" % name)
    else:
        _fail += 1
        _lines.append("  FAIL  %s   ->  %s" % (name, detail))
    return ok


def skip(name: str, why: str) -> None:
    global _skip
    _skip += 1
    _lines.append("  SKIP  %s   (%s)" % (name, why))


def hdr(title: str) -> None:
    _lines.append("")
    _lines.append("=" * 78)
    _lines.append(title)
    _lines.append("=" * 78)


def read(path: str) -> str:
    with io.open(path, encoding="utf-8") as fh:
        return fh.read()


def strip_jsonc(text: str) -> str:
    """去掉 JSONC 的 // 与 /* */ 注释（本仓库的 wrangler.jsonc 用了行注释）。

    字符串感知：注释符出现在引号内不改动。够用即止，不追求完整 JSONC 实现。
    """
    out = []
    i = 0
    n = len(text)
    in_str = False
    while i < n:
        ch = text[i]
        if in_str:
            out.append(ch)
            if ch == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if ch == '"':
                in_str = False
            i += 1
            continue
        if ch == '"':
            in_str = True
            out.append(ch)
            i += 1
            continue
        if ch == "/" and i + 1 < n and text[i + 1] == "/":
            while i < n and text[i] != "\n":
                i += 1
            continue
        if ch == "/" and i + 1 < n and text[i + 1] == "*":
            i += 2
            while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                i += 1
            i += 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def load_jsonc(path: str) -> object:
    return json.loads(strip_jsonc(read(path)))


# --------------------------------------------------------------- 期望值 ----
# #6 决议「三、Cron 编排」定稿的四条表达式
EXPECTED_CRONS = {
    "30 7 * * MON-FRI": "quote_fetch + corporate_action",
    "0 12 * * *": "budget_alert",
    "0 0 * * MON": "report_weekly",
    "10 0 1 * *": "report_monthly",
}
EXPECTED_ROUTE_KEYS = [
    "login", "home", "ledger", "entry", "stock", "expense",
    "budget", "trend", "ca", "tags", "queue", "me",
]
MIN_COMPAT_DATE = "2026-03-03"  # text_decoder_cjk_decoder 默认开启之日


# ============================================================ A 目录形态 ====
def sec_a() -> None:
    hdr("A. 目录形态（deploy-topology §2.1）")

    check("A1 frontend/ 是 Pages 项目根",
          all(os.path.isdir(os.path.join(FRONTEND, d))
              for d in ("public", "src", "functions")))

    check("A2 cron-worker/src/index.ts 存在",
          os.path.isfile(os.path.join(CRON, "src", "index.ts")))

    # §2.2 事实 2：functions/ 必须在 Pages 项目根，**不在**构建输出目录内
    dist_functions = os.path.join(FRONTEND, "dist", "functions")
    check("A3 functions/ 没有落进 dist/（§2.2 事实 2）", not os.path.exists(dist_functions))

    for unit, path in (("frontend", FRONTEND), ("cron-worker", CRON)):
        check("A4 %s/package.json 存在" % unit,
              os.path.isfile(os.path.join(path, "package.json")))


# ================================================== B 配置唯一性与禁项 ====
def sec_b() -> None:
    hdr("B. 配置唯一性与禁项（§2.3 / §3.1 / §3.2 / §11.1 / §11.2 / §11.4）")

    names = {"wrangler.json", "wrangler.jsonc", "wrangler.toml"}
    for unit, path in (("frontend", FRONTEND), ("cron-worker", CRON)):
        found = sorted(n for n in names if os.path.isfile(os.path.join(path, n)))
        check("B1 %s/ 只有一份 wrangler 配置（§11.4）" % unit,
              len(found) == 1, "found=%s" % found)

    fe = load_jsonc(os.path.join(FRONTEND, "wrangler.jsonc"))

    check("B2 frontend 配置没有 main（§11.1 会直接报错）", "main" not in fe)
    check("B3 frontend 配置没有 secrets（§11.2）", "secrets" not in fe)
    check("B4 frontend 有 pages_build_output_dir（判定「是否 Pages 配置」的唯一依据）",
          fe.get("pages_build_output_dir") == "./dist",
          fe.get("pages_build_output_dir"))
    check("B5 frontend 不声明 migrations_dir（§3.2 操作入口单一化）",
          "migrations_dir" not in json.dumps(fe, ensure_ascii=False))

    cw = load_jsonc(os.path.join(CRON, "wrangler.jsonc"))
    for key in ("name", "main", "compatibility_date"):
        check("B6 cron-worker 必填 %s（§2.3）" % key, key in cw)

    cw_d1 = cw.get("d1_databases") or [{}]
    check("B7 只有 cron-worker 声明 migrations_dir（§3.2）",
          cw_d1[0].get("migrations_dir") == "../migrations",
          cw_d1[0].get("migrations_dir"))

    fe_d1 = (fe.get("d1_databases") or [{}])[0]
    same_id = fe_d1.get("database_id") == cw_d1[0].get("database_id")
    check("B8 两处 database_id 一致（§3.1）", same_id,
          "%r vs %r" % (fe_d1.get("database_id"), cw_d1[0].get("database_id")))

    for label, cfg in (("frontend", fe), ("cron-worker", cw)):
        cd = str(cfg.get("compatibility_date", ""))
        check("B9 %s compatibility_date ≥ %s（CJK 解码器）" % (label, MIN_COMPAT_DATE),
              cd >= MIN_COMPAT_DATE, cd)

    placeholders = []
    if str(fe_d1.get("database_id", "")).startswith("REPLACE_ME"):
        placeholders.append("frontend")
    if str(cw_d1[0].get("database_id", "")).startswith("REPLACE_ME"):
        placeholders.append("cron-worker")
    if placeholders:
        _lines.append("  NOTE  database_id 仍是占位符（%s）—— 建库后须同步替换两处"
                      % "、".join(placeholders))


# ================================================ C cron 与分派表一致 ====
def sec_c() -> None:
    hdr("C. cron 表达式与分派表一致（#6 决议 + deploy-topology §2.3）")

    cw = load_jsonc(os.path.join(CRON, "wrangler.jsonc"))
    got = set((cw.get("triggers") or {}).get("crons") or [])

    check("C1 crons 恰好 4 条（账户配额 4/5）", len(got) == 4, "n=%d" % len(got))
    check("C2 crons 集合 == #6 定稿", got == set(EXPECTED_CRONS),
          "多=%s 缺=%s" % (sorted(got - set(EXPECTED_CRONS)),
                           sorted(set(EXPECTED_CRONS) - got)))

    src = read(os.path.join(CRON, "src", "index.ts"))
    # 从 DISPATCH 表里抓键（形如 "30 7 * * MON-FRI": [...]）
    keys = set(re.findall(r'^\s*"([^"]+)":\s*\[', src, re.M))
    check("C3 src/index.ts 的 DISPATCH 键 == crons（改一处漏一处会被抓出来）",
          keys == got, "源码=%s 配置=%s" % (sorted(keys), sorted(got)))

    # `30 7 * * MON-FRI` 必须是两个任务（#13 R9：行情与除权各占一行心跳）
    m = re.search(r'"30 7 \* \* MON-FRI":\s*\[([^\]]*)\]', src)
    tasks = re.findall(r'"([a-z_]+)"', m.group(1)) if m else []
    check("C4 行情日那条分派到 2 个任务（#13 R9 两行心跳）",
          tasks == ["quote_fetch", "corporate_action"], tasks)


# ========================================================== D 静态层 ====
def sec_d() -> None:
    hdr("D. 静态层（§6.2 四项配套 / §11.5 / offline-sync §7.1）")

    pub = os.path.join(FRONTEND, "public")

    routes_p = os.path.join(pub, "_routes.json")
    routes = json.loads(read(routes_p))
    check("D1 _routes.json 收窄到 /api/*（§6.2 ①）",
          routes.get("version") == 1
          and routes.get("include") == ["/api/*"]
          and routes.get("exclude") == [],
          routes)

    check("D2 不写 _redirects（§11.5：会把缺失资产变成 200 HTML）",
          not os.path.exists(os.path.join(pub, "_redirects")))

    headers = read(os.path.join(pub, "_headers"))
    for path in ("/sw.js", "/manifest.webmanifest", "/assets/*"):
        check("D3a _headers 含 %s 规则" % path, path in headers)
    check("D3b _headers 不碰 /api/*（§11.11：对 Function 响应无效，写了是空操作且误导）",
          not re.search(r"^/api/", headers, re.M))

    manifest = json.loads(read(os.path.join(pub, "manifest.webmanifest")))
    check("D4 manifest.display == standalone（offline-sync §7.1 硬门禁）",
          manifest.get("display") == "standalone", manifest.get("display"))
    check("D5 manifest 有 192 与 512 图标（可安装的前提）",
          {i.get("sizes") for i in manifest.get("icons", [])} >= {"192x192", "512x512"},
          [i.get("sizes") for i in manifest.get("icons", [])])

    for name in ("favicon.ico", "sw.js"):
        check("D6 public/%s 存在" % name, os.path.isfile(os.path.join(pub, name)))


# ==================================================== E 构建产物（可选）===
def sec_e() -> None:
    hdr("E. 构建产物（每条对应契约里一处「靠人眼」的条款）")

    dist = os.path.join(FRONTEND, "dist")
    if not os.path.isdir(dist):
        for n in ("E1 dist/ 顶层无 404.html（§11.6）",
                  "E2 dist/_routes.json 存在（§6.2 ① 必须落在构建输出目录）",
                  "E3 dist/_headers 存在",
                  "E4 dist/index.html 存在"):
            skip(n, "还没跑 npm run build")
        return

    check("E1 dist/ 顶层无 404.html（§11.6：有它就关闭 SPA 模式）",
          not os.path.exists(os.path.join(dist, "404.html")))
    check("E2 dist/_routes.json 存在（§6.2 ①）",
          os.path.isfile(os.path.join(dist, "_routes.json")))
    check("E3 dist/_headers 存在", os.path.isfile(os.path.join(dist, "_headers")))
    check("E4 dist/index.html 存在", os.path.isfile(os.path.join(dist, "index.html")))

    # 自写的 _routes.json 必须与源文件内容一致（复制没走样）
    src_r = json.loads(read(os.path.join(FRONTEND, "public", "_routes.json")))
    if os.path.isfile(os.path.join(dist, "_routes.json")):
        dist_r = json.loads(read(os.path.join(dist, "_routes.json")))
        check("E5 dist/_routes.json 与 public/ 源文件一致", src_r == dist_r,
              "%s vs %s" % (src_r, dist_r))


# ================================================== F 路由与页面一致 ====
def sec_f() -> None:
    hdr("F. 前端路由表与页面文件一致（frontend-ia §2.1 / §3.1）")

    routes_src = read(os.path.join(FRONTEND, "src", "routes.ts"))
    keys = re.findall(r'^\s*key:\s*"([a-z]+)"', routes_src, re.M)
    check("F1 路由表恰好 12 条（§3.1 的「12 页」口径）",
          len(keys) == 12, "n=%d %s" % (len(keys), keys))
    check("F2 路由键集合 == §3.1 清单", sorted(keys) == sorted(EXPECTED_ROUTE_KEYS),
          "多=%s 缺=%s" % (sorted(set(keys) - set(EXPECTED_ROUTE_KEYS)),
                           sorted(set(EXPECTED_ROUTE_KEYS) - set(keys))))
    check("F3 不含 `assets`（变体 B 独有产物，*不*进定型清单）", "assets" not in keys)

    # 每个路由键都要有对应的页面文件
    pages_dir = os.path.join(FRONTEND, "src", "pages")
    files = {f for f in os.listdir(pages_dir) if f.endswith(".tsx")}
    missing = []
    for k in keys:
        cand = k.capitalize() + "Page.tsx"
        if cand not in files:
            missing.append(cand)
    check("F4 12 个路由键都有对应页面文件", not missing, missing)
    check("F5 页面文件恰好 12 个（PageStub.tsx 不算）",
          len(files) == 13, "n=%d（12 页 + PageStub）" % len(files))

    tabs = re.search(r"TABS:\s*readonly TabKey\[\]\s*=\s*\[([^\]]*)\]", routes_src)
    tab_list = re.findall(r'"([a-z]+)"', tabs.group(1)) if tabs else []
    check("F6 底栏恰好四个 Tab（§2.1「恰好四个」）", len(tab_list) == 4, tab_list)
    check("F7 Tab 集合 == home/ledger/entry/stock，且 `me` 不在其中",
          tab_list == ["home", "ledger", "entry", "stock"], tab_list)

    raised = re.search(r'RAISED_TAB:\s*TabKey\s*=\s*"([a-z]+)"', routes_src)
    check("F8 凸起的那一格是 `entry`（§2.1 中央凸起）",
          raised is not None and raised.group(1) == "entry",
          raised.group(1) if raised else None)


def main() -> int:
    if not os.path.isdir(FRONTEND):
        print("找不到 frontend/ —— 在仓库根跑本脚本。")
        return 2

    for sec in (sec_a, sec_b, sec_c, sec_d, sec_e, sec_f):
        sec()

    print("\n".join(_lines))
    print()
    print("=" * 78)
    print("合计：%d 通过 / %d 失败 / %d 跳过" % (_pass, _fail, _skip))
    print("=" * 78)
    return 1 if _fail else 0


if __name__ == "__main__":
    sys.exit(main())
