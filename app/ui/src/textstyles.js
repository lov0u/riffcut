/**
 * 文字样式表 —— 唯一一份。
 *
 * ★ 为什么要单独成文件：46 款样式原来只活在剪辑台页面里（05-专业剪辑.html），
 *   导出端 timeline.js 和 AI 工具层 tools.js 都拿不到。结果是：
 *   - AI 能 addtext 加字，但只能给一个「fade / slideUp」这种整块动效，
 *     设不了样式 —— 用户说「给我来个金渐变」，AI 只能把 color 改成金色；
 *   - 导出端只认 c.tcss（已经解析好的声明串），它不认识样式 id，
 *     所以谁敢清掉 tcss 就再也回不来了。
 *   现在三边都从这里取：界面按 id 找 css（颜色用 {C}/{C2} 占位），
 *   导出端拿解析后的 tcss，AI 拿 name 列表。
 *
 * 颜色占位：{C} 主色、{C2} 副色（渐变款的第二档）。解析在 cssOf() 里做。
 * 双端加载：浏览器挂到 window.RC_TEXTSTYLES，Node 走 module.exports。
 */
(function (root, factory) {
  var api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.RC_TEXTSTYLES = api
})(typeof self !== 'undefined' ? self : this, function () {
const TS=[
  {id:'',nm:'默认底衬',css:''},
  {id:'solid',nm:'纯白',css:'font-weight:700;color:{C};'},
  {id:'shadow',nm:'柔影',css:'font-weight:700;color:{C};text-shadow:0 3px 14px rgba(0,0,0,.6);'},
  {id:'plate',nm:'黑底衬',css:'font-weight:700;color:{C};background:rgba(10,16,24,.74);padding:10px 26px;border-radius:10px;'},
  {id:'plateW',nm:'白底衬',css:'font-weight:600;color:#16222A;background:#fff;padding:9px 24px;border-radius:10px;'},
  {id:'pill',nm:'青胶囊',css:'font-weight:600;color:#fff;background:linear-gradient(135deg,#2563EB,#0E6F63);padding:10px 28px;border-radius:999px;'},
  {id:'glass',nm:'毛玻璃',css:'font-weight:600;color:#fff;background:rgba(255,255,255,.16);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.34);padding:10px 24px;border-radius:14px;'},
  {id:'mark',nm:'荧光笔',css:'font-weight:700;color:#101418;background:linear-gradient(180deg,transparent 14%,#D8FF4D 14%,#D8FF4D 86%,transparent 86%);padding:2px 12px;'},
  {id:'uline',nm:'下划重点',css:'font-weight:700;color:{C};border-bottom:4px solid #FF7A50;padding:2px 8px 7px;'},
  {id:'hollowW',nm:'白中空',css:'font-weight:800;color:transparent;-webkit-text-stroke:2px #FFFFFF;letter-spacing:.04em;'},
  {id:'hollowK',nm:'黑中空',css:'font-weight:800;color:transparent;-webkit-text-stroke:2.5px #0E1318;letter-spacing:.04em;'},
  {id:'hollowY',nm:'黄中空',css:'font-weight:800;color:transparent;-webkit-text-stroke:2px #FFC93C;letter-spacing:.04em;'},
  {id:'outline4',nm:'四方描边',css:'font-weight:800;color:#fff;text-shadow:2px 2px 0 #0E1318,-2px 2px 0 #0E1318,2px -2px 0 #0E1318,-2px -2px 0 #0E1318,0 4px 10px rgba(0,0,0,.5);'},
  {id:'variety',nm:'综艺标',css:'font-weight:900;color:#FFE34D;-webkit-text-stroke:3px #0E1318;text-shadow:4px 4px 0 #0E1318;letter-spacing:.02em;'},
  {id:'poster',nm:'大字报',css:'font-weight:900;color:#111;background:#FFE34D;padding:8px 20px;box-shadow:5px 5px 0 #111;letter-spacing:.02em;'},
  {id:'stamp',nm:'印章',css:'font-weight:800;color:#D9372B;border:3px double #D9372B;padding:8px 18px;border-radius:6px;letter-spacing:.14em;'},
  {id:'gold',nm:'金渐变',css:'font-weight:800;background:linear-gradient(180deg,#FFF3C4,#FFC93C 46%,{C2});-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;filter:drop-shadow(0 2px 3px rgba(0,0,0,.5));',c2:'#C98A12'},
  {id:'neon',nm:'霓虹渐变',css:'font-weight:800;background:linear-gradient(90deg,#22D3EE,#A78BFA,{C2});-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;filter:drop-shadow(0 2px 6px rgba(167,139,250,.6));',c2:'#F472B6'},
  {id:'sunset',nm:'晚霞橙粉',css:'font-weight:800;background:linear-gradient(90deg,#FF9A6C,{C2});-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;filter:drop-shadow(0 2px 6px rgba(255,94,126,.55));',c2:'#FF5E7E'},
  {id:'mint',nm:'薄荷',css:'font-weight:800;background:linear-gradient(90deg,#7BF1A8,{C2});-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;',c2:'#39D0D8'},
  {id:'violet',nm:'紫罗兰',css:'font-weight:800;background:linear-gradient(180deg,#C4B5FD,{C2});-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;',c2:'#7C5CFA'},
  {id:'fire',nm:'熔金',css:'font-weight:900;background:linear-gradient(180deg,#FFE066,#FF8A3D 58%,{C2});-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;filter:drop-shadow(0 2px 4px rgba(226,60,30,.5));',c2:'#E23C1E'},
  {id:'ice',nm:'冰蓝',css:'font-weight:800;background:linear-gradient(180deg,#EAFBFF,#7DD3FC 58%,{C2});-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;filter:drop-shadow(0 2px 4px rgba(37,99,235,.5));',c2:'#2563EB'},
  {id:'metal',nm:'金属',css:'font-weight:800;letter-spacing:.06em;background:linear-gradient(180deg,#F8FAFC,#9AA6B4 42%,#E5EAF1 62%,{C2});-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;filter:drop-shadow(0 1px 1px rgba(0,0,0,.55));',c2:'#6B7787'},
  {id:'gradLine',nm:'渐变中空',css:'font-weight:800;background:linear-gradient(90deg,#22D3EE,{C2});-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;-webkit-text-stroke:1px rgba(255,255,255,.9);',c2:'#F472B6'},
  {id:'glowCyan',nm:'青光',css:'font-weight:700;color:#7CF9FF;text-shadow:0 0 6px #22D3EE,0 0 18px #22D3EE,0 0 36px rgba(34,211,238,.6);'},
  {id:'glowPink',nm:'粉光',css:'font-weight:700;color:#FFD1E8;text-shadow:0 0 8px #FF5EB0,0 0 22px #FF5EB0,0 0 42px rgba(255,94,176,.55);'},
  {id:'glowGreen',nm:'绿光',css:'font-weight:700;color:#C9FFD8;text-shadow:0 0 8px #34D058,0 0 22px #34D058,0 0 40px rgba(52,208,88,.5);'},
  {id:'glowRed',nm:'火光',css:'font-weight:700;color:#FFD9C4;text-shadow:0 0 8px #FF5A2C,0 0 24px #FF5A2C,0 0 44px rgba(255,90,44,.5);'},
  {id:'cyber',nm:'赛博框',css:'font-weight:700;color:#22D3EE;border:2px solid #22D3EE;padding:10px 22px;border-radius:2px;letter-spacing:.1em;box-shadow:0 0 12px rgba(34,211,238,.55),inset 0 0 14px rgba(34,211,238,.25);'},
  {id:'thick3d',nm:'厚立体',css:'font-weight:900;color:#fff;text-shadow:0 1px 0 #C9CDD4,0 2px 0 #B9BEC7,0 3px 0 #A9AFBA,0 4px 0 #99A0AC,0 5px 0 #89919E,0 8px 12px rgba(0,0,0,.5);'},
  {id:'longShadow',nm:'长投影',css:'font-weight:800;color:#fff;text-shadow:3px 3px 0 #1D4ED8,6px 6px 0 rgba(29,78,216,.5),9px 9px 0 rgba(29,78,216,.22);'},
  {id:'emboss',nm:'浮雕',css:'font-weight:700;color:#E8EDF3;text-shadow:-1px -1px 0 rgba(255,255,255,.7),1px 1px 2px rgba(0,0,0,.6);'},
  {id:'split',nm:'彩边分离',css:'font-weight:800;color:#fff;text-shadow:-3px 0 0 {C2},3px 0 0 rgba(60,180,255,.9);',c2:'rgba(255,60,120,.9)'},
  {id:'mono',nm:'等宽终端',css:'font-family:ui-monospace,Menlo,"SF Mono",monospace;font-weight:600;color:{C};background:#0D1117;padding:10px 20px;border-radius:6px;border:1px solid #22303C;letter-spacing:.02em;'},
  {id:'serif',nm:'宋体标题',css:'font-family:Georgia,"Songti SC","Noto Serif SC",serif;font-weight:700;color:{C};letter-spacing:.06em;'},
  {id:'hand',nm:'手写体',css:'font-family:"Snell Roundhand","Kaiti SC","STKaiti",cursive;font-style:italic;font-weight:600;color:{C};'},
  {id:'wide',nm:'宽字距',css:'font-weight:600;color:{C};letter-spacing:.4em;text-indent:.4em;'},
  {id:'tight',nm:'紧排大字',css:'font-weight:900;color:{C};letter-spacing:-.03em;'},
  {id:'vert',nm:'竖排',css:'writing-mode:vertical-rl;text-orientation:upright;font-weight:700;color:{C};line-height:1.15;letter-spacing:.08em;padding:6px 10px;'},
  {id:'quote',nm:'引文',css:'font-family:Georgia,"Songti SC",serif;font-style:italic;font-weight:500;color:#E6EBF2;border-left:4px solid #2563EB;padding:4px 0 4px 16px;text-align:left;'},
  {id:'num',nm:'数字标',css:'font-family:"DIN Alternate","Helvetica Neue",sans-serif;font-weight:700;color:{C};font-variant-numeric:tabular-nums;letter-spacing:.02em;'},
  {id:'badge',nm:'角标',css:'font-weight:700;color:#fff;background:#D9372B;padding:6px 14px;border-radius:6px;letter-spacing:.16em;'},
  {id:'ribbon',nm:'斜带',css:'font-weight:700;color:#fff;background:#16222A;padding:9px 30px;clip-path:polygon(8% 0,100% 0,92% 100%,0 100%);'},
  {id:'dashed',nm:'虚线框',css:'font-weight:600;color:{C};border:2px dashed rgba(255,255,255,.62);padding:10px 22px;border-radius:8px;'},
  {id:'soft',nm:'柔光白',css:'font-weight:600;color:#fff;text-shadow:0 0 20px rgba(255,255,255,.85),0 2px 8px rgba(0,0,0,.4);'}
];


/* 整段动效。id 必须与 timeline.js 的 ANIM_PRESETS 键、以及播放器分支逐字对应。 */
const ANIM = [
  ['', '无'], ['fade', '淡入淡出'], ['slideUp', '上滑入'], ['slideDown', '下滑入'],
  ['slideLeft', '左滑入'], ['slideRight', '右滑入'], ['zoomIn', '放大入'], ['zoomOut', '缩小入'],
  ['kenburns', '缓慢推镜'], ['charIn', '逐字弹入'], ['typewriter', '打字机'],
]
/* 逐字动效节奏（秒）。timeline.js 里的 CH_STEP/CH_DUR/TW_STEP 必须与这里逐位相同。 */
const CH_STEP = 0.045, CH_DUR = 0.32, TW_STEP = 0.055
const CHAR_ANIM = ['charIn', 'typewriter']

function byId(id) { return TS.find(s => s && s.id === String(id || '')) || null }

/** 取某一款的 CSS 声明串，把 {C}/{C2} 换成真实颜色。没设副色就用款式自带的。 */
function cssOf(id, color, color2) {
  const st = byId(id)
  if (!st) return ''
  return String(st.css || '')
    .replace(/\{C2\}/g, color2 || st.c2 || '#F472B6')
    .replace(/\{C\}/g, color || '#FFFFFF')
}

/** 这款样式是不是「裸字」（不带底衬）。中空/渐变/发光那几类都是。 */
function isBare(id) {
  const st = byId(id)
  if (!st || !String(st.css || '').trim()) return false
  return !/background/i.test(String(st.css))
}

/** 给 AI 看的口径：id + 中文名，不要 CSS。 */
function list() { return TS.map(s => ({ id: s.id, name: s.nm, two: !!s.c2 })) }

return { TS, ANIM, CH_STEP, CH_DUR, TW_STEP, CHAR_ANIM, byId, cssOf, isBare, list }
})
