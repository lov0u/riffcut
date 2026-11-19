/**
 * RiffCut 影创的界面定制 —— 只做两件事：
 *   1. 侧栏左上角的品牌（图形 + 字标）换成我们的 V 标 + RiffCut 影创
 *   2. 首页中间 hero 的鲸鱼标换成我们的 V 标
 *
 * 为什么用 slots 而不是注入 DOM：DSH 的前端是完整 React + 插槽系统，官方
 * brand-official 插件就是用 `sidebar.brand.mark` / `sidebar.brand.name` /
 * `conversation.hero.brand.mark` 这三个槽位占位的。我们注册同名槽位就会
 * 顶掉它、且 DSH 自己重渲染时不会把我们冲掉。注入 DOM 在下一次重渲染就没了，
 * 还得跟着它的 hashed 类名改，所以不做。
 *
 * ★ 页面其余部分（标题「探索未至之境」、预览版角标、输入框、工作区行、
 *   模型/权限选择器）一律保持 DSH 原样，一个字都不覆盖。
 */
window.__ModuleLoader__.load({
  id: "@velora/client",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let jsx_runtime = require("react/jsx-runtime");
    let react = require("react");

    // ── 品牌常量 ───────────────────────────────────────────────────────
    const WORDMARK = "RiffCut";
    const TAGLINE = "影创";
    const GOLD = "#C9A46A";

    /**
     * 我们的模块清单。每一项在侧栏占一行，点开在右区占满整个 main。
     *
     * id 的规则：`sidebar.panellist` 注册的 id 和 `main` 注册的 key 必须是
     * 同一个字符串，否则点开是空白页（layout 按 activePanelId 去找 main 条目，
     * 找不到就什么都不渲染，也不报错）。
     *
     * icon 见下面 ICONS 表；page 是 studio.html 里的 hash 路由。
     */
    const MODULES = [
      { id: "velora-studio",    label: "剪辑台",   page: "edit",      order: 20 },
      { id: "velora-assets",    label: "素材库",   page: "assets",    order: 21 },
      { id: "velora-templates", label: "模板库",   page: "templates", order: 22 },
      { id: "velora-voice",     label: "AI 配音",  page: "voice",     order: 23 },
      { id: "velora-tasks",     label: "任务中心", page: "tasks",     order: 24 },
      { id: "velora-publish",   label: "发布中心", page: "publish",   order: 25 },
      { id: "velora-hotspot",   label: "热点雷达", page: "hotspot",   order: 26 },
    ];

    /**
     * 一次性把品牌样式打进 head。用 data-plugin-css 打标，热重载重复执行时
     * 不会插第二份（插了也不会坏，但会越堆越多）。
     */
    function injectCss() {
      if (typeof document === "undefined") return;
      const tagId = "@velora/client/brand.css";
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]')) return;
      const tag = document.createElement("style");
      tag.dataset.plugin = "@velora/client";
      tag.dataset.pluginCss = tagId;
      tag.textContent = [
        // 字标：宽字距 + 金色圆点，和深色侧栏对比度够，不用图片
        ".vl-name{display:inline-flex;align-items:baseline;gap:6px;font-weight:600;",
        "letter-spacing:.14em;font-size:14px;line-height:1;color:currentColor;",
        "font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Helvetica Neue',sans-serif}",
        ".vl-name .vl-dot{width:5px;height:5px;border-radius:50%;background:" + GOLD + ";",
        "display:inline-block;margin-bottom:3px;flex:none}",
        ".vl-name .vl-tag{font-size:11px;letter-spacing:.28em;opacity:.62;font-weight:400}",
        // 图形：跟随宿主的 size，currentColor 描边，金色节点做记忆点
        ".vl-mark{display:inline-flex;align-items:center;justify-content:center;flex:none}",
        ".vl-mark svg{width:100%;height:100%;display:block}",
        // 选中态让图标跟着宿主的强调色走，不自己定颜色 —— 深浅色主题都要对
        ".vl-mark-on{color:var(--dsw-alias-label-primary,currentColor)}",
      ].join("");
      document.head.appendChild(tag);
    }

    // ── 组件 ───────────────────────────────────────────────────────────

    /**
     * 品牌图形：一个 V 形折角 + 金色节点。22px 以下仍然清楚，所以侧栏
     * （16/18px）和 hero（34px）用同一个组件，只是尺寸不同。
     * @param {{size?:number}} props - 宿主传的尺寸。
     */
    function VeloraMark({ size }) {
      const s = size || 22;
      return jsx_runtime.jsx("span", {
        className: "vl-mark",
        style: { width: s + "px", height: s + "px" },
        children: jsx_runtime.jsxs("svg", {
          viewBox: "0 0 24 24",
          fill: "none",
          children: [
            jsx_runtime.jsx("path", {
              d: "M3 5.5 L12 20 L21 5.5",
              stroke: "currentColor",
              strokeWidth: "1.6",
              strokeLinecap: "round",
              strokeLinejoin: "round",
            }),
            jsx_runtime.jsx("circle", { cx: "12", cy: "20", r: "1.9", fill: GOLD }),
          ],
        }),
      });
    }

    /**
     * 侧栏品牌字标：• RiffCut 影创。
     * 点不能省 —— 没有它整行看着像普通文字，撑不住侧栏的视觉锚点。
     */
    function VeloraName() {
      return jsx_runtime.jsxs("span", {
        className: "vl-name",
        children: [
          jsx_runtime.jsx("span", { className: "vl-dot" }),
          jsx_runtime.jsx("span", { children: WORDMARK }),
          jsx_runtime.jsx("span", { className: "vl-tag", children: TAGLINE }),
        ],
      });
    }

    // ── 侧栏图标 ───────────────────────────────────────────────────────

    /**
     * 7 个模块的线性图标，统一 viewBox 0 0 24 24 / stroke 1.6 / currentColor。
     *
     * 为什么自己画不用 @deepseek-ai/dsh-client-ui-primitives 里的图标：
     * 那个包在这个内核里根本不存在（`require` 得到的是宿主注入的空壳），
     * 引用它的具名导出会拿到 undefined，渲染时白屏且控制台只有一行
     * "Cannot read properties of undefined"。自己画 24×24 的 path 最稳。
     */
    const ICONS = {
      // 剪辑台：场记板
      edit: [
        { t: "rect", x: 2.5, y: 5, w: 19, h: 15, rx: 2.5 },
        { t: "path", d: "M2.5 10h19M7 5l2.4 5M13 5l2.4 5" },
      ],
      // 素材库：两张叠起来的照片 + 山形
      assets: [
        { t: "rect", x: 2.5, y: 6.5, w: 14, h: 12, rx: 2 },
        { t: "path", d: "M19.5 8.5v9a3 3 0 0 1-3 3h-9" },
        { t: "path", d: "M2.5 15l3.6-3.4a1.6 1.6 0 0 1 2.2 0L13 16" },
        { t: "circle", cx: 12, cy: 10.4, r: 1.3 },
      ],
      // 模板库：四宫格
      templates: [
        { t: "rect", x: 3, y: 3, w: 7.5, h: 7.5, rx: 1.6 },
        { t: "rect", x: 13.5, y: 3, w: 7.5, h: 7.5, rx: 1.6 },
        { t: "rect", x: 3, y: 13.5, w: 7.5, h: 7.5, rx: 1.6 },
        { t: "rect", x: 13.5, y: 13.5, w: 7.5, h: 7.5, rx: 1.6 },
      ],
      // AI 配音：声波
      voice: [
        { t: "path", d: "M4 10v4M8 6.5v11M12 3.5v17M16 7.5v9M20 10.5v3" },
      ],
      // 任务中心：清单 + 勾
      tasks: [
        { t: "path", d: "M4 6.5h3M4 12h3M4 17.5h3" },
        { t: "path", d: "M10 6.5h10M10 12h7M10 17.5h10" },
        { t: "path", d: "M4.4 6.2l1 1 1.8-2" },
      ],
      // 发布中心：上传
      publish: [
        { t: "path", d: "M12 16.5V4.5" },
        { t: "path", d: "M7.6 8.9L12 4.5l4.4 4.4" },
        { t: "path", d: "M3.5 15v3.5a1.8 1.8 0 0 0 1.8 1.8h13.4a1.8 1.8 0 0 0 1.8-1.8V15" },
      ],
      // 热点雷达：雷达圈 + 扫描线
      hotspot: [
        { t: "circle", cx: 12, cy: 12, r: 8.5 },
        { t: "circle", cx: 12, cy: 12, r: 4 },
        { t: "path", d: "M12 12l6-3.4" },
      ],
    };

    /**
     * 把一个图标描述对象渲染成 SVG 子元素。
     * @param {object} d - ICONS 里的单条描述。
     * @param {number} i - key 用。
     */
    function iconShape(d, i) {
      const common = {
        key: i,
        stroke: "currentColor",
        strokeWidth: "1.6",
        strokeLinecap: "round",
        strokeLinejoin: "round",
        fill: "none",
      };
      if (d.t === "rect") {
        return jsx_runtime.jsx("rect", {
          ...common, x: d.x, y: d.y, width: d.w, height: d.h, rx: d.rx,
        });
      }
      if (d.t === "circle") {
        return jsx_runtime.jsx("circle", { ...common, cx: d.cx, cy: d.cy, r: d.r });
      }
      return jsx_runtime.jsx("path", { ...common, d: d.d });
    }

    /**
     * 侧栏一行用的图标组件。宿主传 `size`（折叠 18 / 展开 16）和 `active`。
     * @param {{size?:number, active?:boolean, name:string}} props
     */
    function makeIcon(name) {
      return function ModuleIcon({ size, active }) {
        const s = size || 18;
        return jsx_runtime.jsx("span", {
          className: "vl-mark" + (active ? " vl-mark-on" : ""),
          style: { width: s + "px", height: s + "px" },
          children: jsx_runtime.jsx("svg", {
            viewBox: "0 0 24 24",
            fill: "none",
            "aria-hidden": "true",
            children: (ICONS[name] || []).map(iconShape),
          }),
        });
      };
    }

    // ── 模块页面 ───────────────────────────────────────────────────────

    /**
     * 模块面板。用 iframe 装 studio.html，靠 hash 决定进哪一屏。
     *
     * 为什么用 iframe 而不是直接用 React 画：
     *  - 剪辑台/素材库/模板库内部状态很重（时间线、预览、批量选择），
     *    出异常只死这一个 iframe，不会把 DSH 的会话页整片打白；
     *  - DSH 前端换版本时，hashed 类名、组件结构全变，这两处（品牌 + 模块页）
     *    之外我们一行都不用跟着改；
     *  - 我们自己的界面本来就是独立的 HTML，直接嵌进来是零改造成本。
     */
    function makePage(mod) {
      return function ModulePage() {
        const [err, setErr] = react.useState("");
        const ref = react.useRef(null);
        react.useEffect(() => {
          const win = ref.current && ref.current.contentWindow;
          if (!win) return;
          let timer = 0;
          timer = window.setTimeout(() => {
            try {
              const d = win.document;
              if (d && d.readyState === "complete" && d.body && d.body.childElementCount === 0) {
                setErr("这一屏没有加载出来。先关掉软件重开一次；还不行就是 studio.html 有语法错。");
              }
            } catch {
              // 跨源读不到属正常（说明页面已经自己跑起来了）
            }
          }, 5000);
          return () => window.clearTimeout(timer);
        }, []);
        return jsx_runtime.jsxs("div", {
          style: {
            width: "100%", height: "100%",
            display: "flex", flexDirection: "column", overflow: "hidden",
          },
          children: [
            err ? jsx_runtime.jsx("div", {
              style: {
                padding: "10px 16px", fontSize: "12.5px", color: "#8a6a2f",
                background: "#fdf6e6", borderBottom: "1px solid #f0e2c4", flex: "none",
              },
              children: err,
            }) : null,
            jsx_runtime.jsx("iframe", {
              ref,
              src: "velora://studio/#" + mod.page,
              title: mod.label,
              style: {
                flex: "1 1 auto", width: "100%", height: "100%",
                border: "0", background: "transparent", display: "block",
              },
              allow: "microphone; camera; clipboard-write; fullscreen",
            }),
          ],
        });
      };
    }

    // ── 注册 ───────────────────────────────────────────────────────────
    /** 只要插槽注册表。 */
    const inject = ["slots"];

    /**
     * 注册三个槽位。注意嵌套 injin 的写法：brand.name 依赖 brand.mark 先就位
     * （官方 brand-official 就是这种套法），hero 单独一条线。
     * @param ctx - 浏览器侧根上下文。
     */
    function apply(ctx) {
      injectCss();

      // 侧栏左上：图形 + 字标。两个槽位要一起注册，只注册一个会剩半个原文案。
      ctx.slots.inject("sidebar.brand.mark", () =>
        ctx.slots.inject("sidebar.brand.name", function* () {
          yield ctx.slots.register({ name: "sidebar.brand.mark" }, VeloraMark);
          yield ctx.slots.register({ name: "sidebar.brand.name" }, VeloraName);
        })
      );

      // 左栏我们自己的模块（用户圈的第二处）。
      //
      // DSH 原生的「新会话 / 插件 / 自动化任务 / 更多 / 工作区」一个字都不动，
      // 我们在它们后面接上自己这几行。每行 = 一个 sidebar.panellist 条目 +
      // 一个 main 条目，两者的 id/key 必须相同。
      //
      // 全部塞进同一个 inject 生成器里：sidebar 的 syncPanels 靠
      // slots.subscribe("sidebar.panellist") 重算列表，分两次注册会让它在
      // 中间那一刻只看到一半（表现为侧栏闪一下、顺序乱）。
      ctx.slots.inject("sidebar.panellist", function* () {
        for (const mod of MODULES) {
          const Icon = makeIcon(mod.page);
          yield ctx.slots.register({
            name: "sidebar.panellist",
            id: mod.id,
            order: mod.order,
            label: () => mod.label,
          }, Icon);
        }
        yield ctx.slots.inject("main", function* () {
          for (const mod of MODULES) {
            yield ctx.slots.register(
              { name: "main", key: mod.id },
              makePage(mod)
            );
          }
        });
      });

      // 首页 hero：只换鲸鱼标。标题「探索未至之境」和「预览版」角标是 locale
      // 文案，不能靠 locale.register 覆盖（同一个 namespace 重复注册会抛
      // `locale namespace "conversation" already has locale "zh"`），所以保留原文。
      ctx.slots.inject("conversation.hero.brand.mark", () =>
        ctx.slots.register({ name: "conversation.hero.brand.mark" }, VeloraMark)
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
