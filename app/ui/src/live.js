/* RiffCut 影创 · 真实功能接线层
   由 build.py 注入到页面末尾。所有按钮调本机 /api/*，不再只是弹提示。 */
(function(){
  var $=function(s){return document.querySelector(s)},
      $$=function(s){return [].slice.call(document.querySelectorAll(s))},
      A=function(p,d){return window.api(p,d)},
      say=function(m,bad,force){window.say(m,bad,force)},
      V=function(){return window.RiffCut||{}};
  function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
  function mark(nodes){nodes.forEach(function(x){x.setAttribute('data-live','1')});return nodes}
  function byDemo(t){return $$('[data-demo="'+t+'"]')}
  /* 原生粘贴桥：Swift「编辑→粘贴」把系统剪贴板文本送进来，保证 ⌘V 一定可用 */
  window.__riffcutPaste=function(txt,target){
    var el=target||document.activeElement;
    if(!el||(el.tagName!=='INPUT'&&el.tagName!=='TEXTAREA')){
      el=document.querySelector('#mModal.open input:not([type=checkbox]):not([type=radio])')
         ||document.querySelector('input:not([type=checkbox]):not([type=radio])');
    }
    if(!el)return false;
    txt=String(txt==null?'':txt);
    var v=el.value||'',s=el.selectionStart,e2=el.selectionEnd;
    if(typeof s==='number'&&typeof e2==='number'){
      el.value=v.slice(0,s)+txt+v.slice(e2);
      el.selectionStart=el.selectionEnd=s+txt.length;
    }else{el.value=v+txt;}
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.focus();
    return true;
  };

  /* ══════════ 通用：网页话筒录音 → 16kHz 单声道 WAV（base64） ══════════
     为什么不用服务端录：内嵌 ffmpeg 是静态构建，没编 avfoundation 输入设备，
     服务端根本拿不到麦克风。界面这层有系统麦克风授权（语音输入一直在用），
     录出来的 16k WAV 正好是声音克隆要的格式。
     用法：window.riffcutRecWav({seconds:6,onTick:function(left,total){}})
             .then(function(r){ r.b64 是 WAV 的 base64 }) */
  function _wavFrom(chunks,total,rate){
    var target=16000,i,j,s,off=0;
    var src=new Float32Array(total);
    for(i=0;i<chunks.length;i++){src.set(chunks[i],off);off+=chunks[i].length}
    var ratio=(rate&&rate!==target)?rate/target:1;
    var n=Math.max(1,Math.floor(src.length/ratio));
    var buf=new ArrayBuffer(44+n*2),v=new DataView(buf);
    function ws(o,str){for(var k=0;k<str.length;k++)v.setUint8(o+k,str.charCodeAt(k))}
    ws(0,'RIFF');v.setUint32(4,36+n*2,true);ws(8,'WAVE');
    ws(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);
    v.setUint32(24,target,true);v.setUint32(28,target*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);
    ws(36,'data');v.setUint32(40,n*2,true);
    for(j=0;j<n;j++){
      var x=j*ratio,i0=Math.floor(x),i1=(i0+1<src.length)?i0+1:i0,f=x-i0;
      s=src[i0]*(1-f)+src[i1]*f;
      s=s>1?1:(s<-1?-1:s);
      v.setInt16(44+j*2,s<0?s*0x8000:s*0x7FFF,true);
    }
    return buf;
  }
  function _b64(ab){
    var bytes=new Uint8Array(ab),bin='',step=8192;
    for(var i=0;i<bytes.length;i+=step)
      bin+=String.fromCharCode.apply(null,bytes.subarray(i,i+step));
    return btoa(bin);
  }
  window.riffcutRecWav=function(opts){
    opts=opts||{};
    var sec=Math.max(2,Math.min(60,Math.round(opts.seconds||6)));
    return new Promise(function(res,rej){
      if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
        rej(new Error('这台机器打不开麦克风'));return;
      }
      navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,
        noiseSuppression:true,autoGainControl:true}}).then(function(st){
        var AC=window.AudioContext||window.webkitAudioContext,ctx;
        try{ctx=new AC({sampleRate:16000})}catch(e){try{ctx=new AC()}catch(e2){
          st.getTracks().forEach(function(t){t.stop()});rej(new Error('打不开麦克风通道'));return}}
        var rate=ctx.sampleRate||16000;
        var src=ctx.createMediaStreamSource(st);
        var proc=ctx.createScriptProcessor(4096,1,1);
        var chunks=[],total=0,peak=0,stopped=false,t0=Date.now(),timer=null;
        function cleanup(){
          stopped=true;
          if(timer)clearInterval(timer);
          try{proc.disconnect()}catch(e){}
          try{src.disconnect()}catch(e){}
          try{ctx.close()}catch(e){}
          st.getTracks().forEach(function(t){try{t.stop()}catch(e){}});
        }
        function finish(){
          if(stopped)return;
          var dur=total/rate;
          var b64=_b64(_wavFrom(chunks,total,rate));
          cleanup();
          if(dur<0.8){rej(new Error('录得太短了，再多说一会儿'));return}
          if(peak<0.004){rej(new Error('没听到声音：检查麦克风有没有被系统静音，或是否授权给本软件'));return}
          res({b64:b64,seconds:+dur.toFixed(1)});
        }
        proc.onaudioprocess=function(ev){
          if(stopped)return;
          var d=ev.inputBuffer.getChannelData(0);
          chunks.push(new Float32Array(d));total+=d.length;
          for(var i=0;i<d.length;i+=4){var a=d[i]<0?-d[i]:d[i];if(a>peak)peak=a}
        };
        src.connect(proc);proc.connect(ctx.destination);
        window.__riffcutRecStop=finish;
        timer=setInterval(function(){
          var used=Math.round((Date.now()-t0)/1000),left=Math.max(0,sec-used);
          if(opts.onTick)opts.onTick(left,sec);
          if(left<=0)finish();
        },250);
      }).catch(function(e){
        rej(new Error((e&&e.name==='NotAllowedError')
          ? '麦克风没授权：到「系统设置 → 隐私与安全性 → 麦克风」里允许本软件'
          : ((e&&e.message)||'打不开麦克风')));
      });
    });
  };
  /* 提前结束录音（点「录制中」再点一下 / 点不到等）：UI 想用就调 */
  window.riffcutRecStop=function(){
    if(typeof window.__riffcutRecStop==='function'){try{window.__riffcutRecStop()}catch(e){}}
  };

  /* ══════════ 通用：录音引导卡片（屏幕正中，先给词再开录） ══════════
     为什么要有这一步：原来点「开始录制」立刻开录，用户还没看清该念什么，
     6 秒已经过去一半，录出来的样本太短、克隆出来不像。
     现在：中间弹卡片给一句话 → 点「开始朗读」→ 倒数 3 秒 → 才真正计时录。 */
  var VCG_TEXT='在影创的镜头下，每一个瞬间都值得被定格，让创意，成为影像。';
  window.RiffCut_SAMPLE_TEXT=VCG_TEXT;
  function vcgCss(){
    if(document.getElementById('vcgCss'))return;
    var st=document.createElement('style');st.id='vcgCss';
    st.textContent=[
      '.vcg-mask{position:fixed;inset:0;z-index:900;display:flex;align-items:center;justify-content:center;',
        'background:rgba(20,26,38,.44);backdrop-filter:blur(3px)}',
      '.vcg-card{position:relative;width:min(700px,92vw);background:#fff;border-radius:12px;',
        'border:1px solid rgba(20,28,44,.08);box-shadow:0 30px 90px rgba(14,20,32,.36);overflow:hidden;',
        'font-family:inherit;color:#1E2430;animation:vcgPop .2s cubic-bezier(.2,.9,.3,1.1)}',
      '@keyframes vcgPop{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}',
      '.vcg-hd{display:flex;align-items:center;gap:10px;padding:15px 20px 13px;border-bottom:1px solid #EDF0F5}',
      '.vcg-hd b{font-size:15px;font-weight:600}',
      '.vcg-tag{margin-left:auto;font-size:10.5px;line-height:1;padding:5px 9px;border-radius:12px;',
        'background:#F2F4F8;color:#7A828F;letter-spacing:.3px;white-space:nowrap}',
      '.vcg-tag.warm{background:#EFF4FF;color:#5A6272}',
      '.vcg-tag.live{background:#FDECEC;color:#C13B3B}',
      '.vcg-tag.live::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;',
        'background:#D94141;margin-right:5px;vertical-align:1px;animation:vcgBlink 1s infinite}',
      '@keyframes vcgBlink{0%,100%{opacity:1}50%{opacity:.25}}',
      '.vcg-tag.ok{background:#EAF7EF;color:#2E7D52}',
      '.vcg-tag.bad{background:#FDECEC;color:#C13B3B}',
      '.vcg-bd{padding:16px 20px 0}',
      '.vcg-lead{font-size:12px;line-height:1.75;color:#6B7280;margin-bottom:12px}',
      '.vcg-text{font-size:20px;line-height:1.9;letter-spacing:.4px;text-align:center;color:#1E2430;',
        'font-weight:500;background:#FFFFFF;border:1px dashed #F4F6FA;border-radius:12px;',
        'padding:16px 18px;user-select:text}',
      '.vcg-card.rec .vcg-text{background:#FFF8F6;border-color:#F0C6BD}',
      '.vcg-prog{height:4px;border-radius:4px;background:#EEF1F6;overflow:hidden;margin:14px 0 8px}',
      '.vcg-prog i{display:block;height:100%;width:0;border-radius:4px;',
        'background:linear-gradient(90deg,#EFF4FF,#2563EB);transition:width .28s linear}',
      '.vcg-meta{font-size:12px;line-height:1.6;color:#8A92A2;text-align:center;padding-bottom:14px}',
      '.vcg-meta b{color:#1E2430;font-weight:600}',
      '.vcg-meta.err{color:#C13B3B}',
      '.vcg-ft{display:flex;align-items:center;justify-content:flex-end;gap:9px;padding:12px 20px;',
        'border-top:1px solid #EDF0F5;background:#FFFFFF}',
      '.vcg-btn{height:34px;padding:0 18px;border-radius:8px;border:1px solid #E1E5EE;background:#fff;',
        'color:#3A4252;font-size:12px;font-family:inherit;cursor:pointer}',
      '.vcg-btn:hover{background:#F4F6FA}',
      '.vcg-btn.primary{background:#2563EB;border-color:#2563EB;color:#fff;font-weight:600;min-width:112px}',
      '.vcg-btn.primary:hover{background:#2563EB}',
      '.vcg-btn:disabled{opacity:.6;cursor:default}'
    ].join('');
    document.head.appendChild(st);
  }
  /* 用法：window.riffcutRecGuide({text:'要念的句子',seconds:6,title:'录制我的音色'})
     返回 Promise：拿到 {b64,seconds,close} → 自己去保存，保存完调 close()；
     用户点取消 → null（什么都不提示，别自说自话）。 */
  window.riffcutRecGuide=function(opts){
    opts=opts||{};
    var text=String(opts.text||VCG_TEXT),sec=Math.max(3,Math.min(60,Math.round(opts.seconds||6)));
    return new Promise(function(resolve,reject){
      if(!window.riffcutRecWav){reject(new Error('这台机器打不开麦克风'));return}
      vcgCss();
      var wrap=document.createElement('div');wrap.className='vcg-mask';
      wrap.innerHTML='<div class="vcg-card" role="dialog" aria-modal="true">'
        +'<div class="vcg-hd"><b>'+esc(opts.title||'录制我的音色')+'</b>'
        +'<span class="vcg-tag" data-tag>准备</span></div>'
        +'<div class="vcg-bd">'
          +'<div class="vcg-lead">对着麦克风，用你平时说话的语气念下面这句，一次念完、中间别停。'
          +'点「开始朗读」后倒数 3 秒才开始计时。</div>'
          +'<div class="vcg-text">'+esc(text)+'</div>'
          +'<div class="vcg-prog"><i data-bar></i></div>'
          +'<div class="vcg-meta" data-meta>共 <b>'+sec+'</b> 秒 · 准备好了就点右下角</div>'
        +'</div>'
        +'<div class="vcg-ft"><button class="vcg-btn" data-cancel>取消</button>'
        +'<button class="vcg-btn primary" data-go>开始朗读</button></div></div>';
      document.body.appendChild(wrap);
      var q=function(s){return wrap.querySelector(s)},
          card=q('.vcg-card'),go=q('[data-go]'),cancel=q('[data-cancel]'),
          bar=q('[data-bar]'),meta=q('[data-meta]'),tag=q('[data-tag]');
      var phase='idle',timer=null,dropped=false,closed=false;
      function setTag(t,cls){tag.className='vcg-tag'+(cls?' '+cls:'');tag.textContent=t}
      function closeCard(){
        if(closed)return;closed=true;
        if(timer){clearInterval(timer);timer=null}
        document.removeEventListener('keydown',onKey,true);
        if(wrap.parentNode)wrap.parentNode.removeChild(wrap);
      }
      function onKey(e){
        if(closed)return;
        if(e.key==='Escape'){e.preventDefault();doCancel()}
      }
      function doCancel(){
        if(phase==='saving')return;          /* 保存中不让关，不然样本丢了没反馈 */
        if(timer){clearInterval(timer);timer=null}
        if(phase==='rec'){dropped=true;try{window.riffcutRecStop()}catch(e){}}
        closeCard();resolve(null);
      }
      function startCount(){
        phase='count';go.disabled=true;go.textContent='准备中…';
        setTag('准备','warm');card.classList.remove('rec');meta.classList.remove('err');
        var n=3;
        meta.innerHTML='<b>'+n+'</b> 秒后开始，张嘴念上面这句话';
        timer=setInterval(function(){
          n--;
          if(n>0){meta.innerHTML='<b>'+n+'</b> 秒后开始，张嘴念上面这句话';return}
          clearInterval(timer);timer=null;startRec();
        },1000);
      }
      function startRec(){
        phase='rec';card.classList.add('rec');setTag('录音中','live');
        go.disabled=false;go.textContent='念完了 · 提前结束';bar.style.width='0%';
        meta.innerHTML='正在录音 · 还剩 <b>'+sec+'</b> 秒';
        window.riffcutRecWav({seconds:sec,onTick:function(left,total){
          if(closed||phase!=='rec')return;
          bar.style.width=(Math.min(1,(total-left)/total)*100).toFixed(1)+'%';
          meta.innerHTML='正在录音 · 还剩 <b>'+left+'</b> 秒，把这句话念完';
        }}).then(function(r){
          if(closed||dropped){closeCard();resolve(null);return}
          phase='saving';card.classList.remove('rec');setTag('已录好','ok');
          bar.style.width='100%';meta.classList.remove('err');
          meta.innerHTML='正在保存并识别你念的词…';
          go.style.display='none';cancel.textContent='关闭';cancel.disabled=true;
          resolve({b64:r.b64,seconds:r.seconds,close:closeCard});
        }).catch(function(e){
          if(closed||dropped){closeCard();resolve(null);return}
          phase='idle';card.classList.remove('rec');setTag('没录成','bad');
          meta.className='vcg-meta err';meta.innerHTML=esc((e&&e.message)||'录音失败');
          go.style.display='';go.disabled=false;go.textContent='重新录';
          cancel.textContent='取消';
        });
      }
      go.addEventListener('click',function(){
        if(phase==='idle')startCount();
        else if(phase==='rec'){try{window.riffcutRecStop()}catch(e){}}
      });
      cancel.addEventListener('click',doCancel);
      document.addEventListener('keydown',onKey,true);
    });
  };

  /* ══════════ 02 · AI 导演 ══════════
     逻辑全部移到页面自身脚本（按客户分组存档 / 真实流程面板 / 确认框删除），
     这里不再重复绑定，避免同一次点击触发两套行为。 */
  /* 全软件通用确认框：弹窗 DOM 放在 shell.html 全局区，任意页面都能弹出 */
  window.confirmAction=confirmAction;

  /* ══════════ 03 · 客户与素材库 ══════════
     逻辑全部移到页面自身脚本（真实客户增删切换 / 手动扫描 / 生成素材索引），
     这里不再重复绑定，避免同一次点击触发两套行为。 */

  /* ══════════ 04 · AI 语音工作室 ══════════
     逻辑全部移到页面自身脚本（本地语音模型目录 / 能力驱动音色 / 试听 / 录制 / 导入 / 国内镜像安装），
     这里不再重复绑定 [data-play] 与「功能待接入」旧按钮，避免同一次点击触发两套行为。 */

  /* ══════════ 05 · 专业剪辑台 ══════════
     参数（帧率 / 字幕文字 / 音乐 / 编码 / CRF）、真预览、质检、时间线、只重做某段
     全部移到 05 页自身脚本；这里不再绑定 .e-clip / #eTracks，避免双绑。 */

  /* 06 · Skill 技能中心：增删编辑启停、导入导出、扫描本机技能全部由 06 页自身脚本接管，
     这里不再重复绑定 data-demo 按钮，避免出现两套状态。 */

  /* ══════════ 07 · 模型管理（一个列表 + 是否支持图片） ══════════ */
  var M_STATE = {models:{}, editing:'', scan:null};
  function isBlankSlot(id,m){
    if(!m.builtin) return false;
    return !m.chat || !((m.url||'').trim() && (m.model||'').trim());
  }

  function esc2(s){ return esc(s == null ? '' : String(s)); }
  function mState(m){
    return (m.key_set && (m.model || '').trim() && (m.url||'').trim()) ? '已配置' : '待配置';
  }
  function mTagClass(t){ return t === '已配置' ? 'green' : 'gray'; }

  function renderModelGroups(){
    var box = $('#mGroups'); if(!box) return;
    var ms = M_STATE.models || {};
    // 打开就能用的模型不进「我的模型」；这里只列用户自己添加、编辑过的
    var ids = Object.keys(ms).filter(function(id){ return !isBlankSlot(id, ms[id]); });
    var cards = ids.length ? ids.map(function(id){
      var m = ms[id], st = mState(m);
      var kind = m.mtype || (m.image ? 'image' : (m.video ? 'video' : (m.vision ? 'vision' : 'text')));
      var KL = {text:'文本模型', vision:'多模态模型', video:'视频模型', image:'生图模型'};
      var tags = '<span class="m-ktag ' + kind + '">' + esc2(m.mtype_label || KL[kind]) + '</span>' +
                 '<span class="u-tag ' + mTagClass(st) + '">' + esc2(st) + '</span>';
      // 模型管理页不设「默认」：对话页顶部的模型下拉点一下就选中，路由按这个选择走
      return '<div class="m-model-card" data-id="' + esc2(id) + '">' +
        '<div><div class="mc-name">' + esc2(m.name || id) + '</div>' +
        '<div class="mc-tags">' + tags + '</div></div>' +
        '<div class="mc-meta">' + esc2(m.vendor || '自定义') +
        ' · 模型 ID：<span>' + esc2(m.model || '未填') + '</span>' +
        (m.key_set
          ? '<div class="mc-key">' + (m.preset ? (m.presetKey ? '已填自己的 Key' : '内置额度 · 开箱即用，可换成自己的') : '密钥 ' + esc2(m.key_hint || '已保存')) + '</div>'
          : (m.preset ? '<div class="mc-key">' + (m.presetKey ? '点「编辑」去注册拿 Key' : '内置额度') + '</div>' : '')) +
        '</div>' +
        '<div class="mc-acts">' +
          '<button data-act="edit" data-id="' + esc2(id) + '">编辑</button>' +
          (m.url ? '<button data-act="test" data-id="' + esc2(id) + '">测试</button>' : '') +
          /* 删除按钮的规则：内置额度卡（preset-auto）不给删 —— 删了就没有开箱即用的
             默认模型了；但「预设供应商卡」（白鹿这种 presetKey 有值的）允许删，
             它是给用户省事用的入口，不想用白鹿的人应该能把它去掉。
             以前 preset 一律不给删，结果白鹿卡永远钉在「我的模型」里。 */
          ((!m.builtin || (m.preset && m.presetKey)) ? '<button class="danger" data-act="del" data-id="' + esc2(id) + '">删除</button>' : '') +
        '</div></div>';
    }).join('') : '<div class="m-empty">还没有模型。点右上「添加模型」，填接口地址、API Key，再点「读取可用模型」勾选要添加的几个；也可手动填一个模型 ID。</div>';
    box.innerHTML = '<div class="u-card m-my-hd">' +
      '<div class="m-g-hd"><div class="m-g-ic"><svg class="ic"><use href="#i-sliders"/></svg></div>' +
      '<div class="m-g-t"><b>我的模型</b><span>首页下拉只列文本模型和多模态模型；生图 / 视频由 AI 导演按需自动调用</span></div>' +
      '<span class="u-tag gray">' + ids.length + ' 个</span></div>' +
      '<div class="m-g-foot"><button class="u-btn sm" data-add="1">添加 / 配置</button></div>' +
      '</div><div class="m-grid">' + cards + '</div>';
    /* ★ 逐按钮直挂一层兜底。
       document 级事件委托本来是够的，但实测有的卡片上「测试」点了毫无反应
       （按钮被按下、文字不变、底部也没提示）。与其猜是哪一层拦了事件，
       不如在渲染完的这一刻直接给每个按钮绑一次 —— 直挂一定生效，
       并且跟委托那层并存：委托先处理过会 mark 掉，这里 check 一下不重复跑。 */
    box.querySelectorAll('.m-grid button[data-act]').forEach(function(b){
      if(b.getAttribute('data-bound') === '1') return;
      b.setAttribute('data-bound', '1');
      b.addEventListener('click', function(ev){
        /* 委托层已经处理过（它会把按钮 disabled 或页面已刷新）就不再重复 */
        if(b.disabled) { return }
        var id2 = b.getAttribute('data-id'), act2 = b.getAttribute('data-act');
        if(!id2 || act2 !== 'test') return;
        ev.stopPropagation();     // 防止委托层再跑一次，导致两次请求
        b.disabled = true; b.textContent = '测试中…';
        var back = function(){ b.disabled = false; b.textContent = '测试' };
        var m2 = M_STATE.models[id2] || {};
        say('正在测试「' + (m2.name || id2) + '」…', false, true);
        var fin = false;
        var guard = setTimeout(function(){
          if(fin) return; fin = true; back(); say('✗ 测试超时（12 秒没回应）', true, true);
        }, 12000);
        A('/api/models', {action: (m2.vision ? 'test_vision' : 'test'), id: id2}).then(function(r){
          if(fin) return; fin = true; clearTimeout(guard); back();
          var ok = !!(r && r.ok);
          var txt = (r && (r.text || r.reply)) || '';
          say(ok ? ('✓ 连接正常：' + (txt || '（空回答）')) : ('✗ 连接失败：' + (txt || '未知错误')), !ok, true);
        }).catch(function(e){
          if(fin) return; fin = true; clearTimeout(guard); back();
          say('✗ 连接失败：' + ((e && e.message) || e), true, true);
        });
      });
    });
  }

  function renderRoutes(){}

  function modelKind(m){
    return m.image ? 'image' : (m.video ? 'video' : (m.vision ? 'vision' : 'text'));
  }
  var KIND_LABEL = {text:'文本模型', vision:'多模态模型', video:'视频模型', image:'生图模型'};
  function loadModels(){
    return A('/api/models',{action:'list'}).then(function(ms){
      M_STATE.models = ms || {};
      renderModelGroups();
      // 同步到全局：首页下拉只拿到文本 / 多模态模型，生成类模型只给 AI 导演后台用
      var W = window.RiffCut || (window.RiffCut = {});
      var ids = Object.keys(ms).filter(function(id){ return !isBlankSlot(id, ms[id]); });
      W.models = ids.map(function(id){
        var m = ms[id], k = modelKind(m);
        return Object.assign({}, m, {id:id, mtype:k, mtype_label:KIND_LABEL[k]});
      });
      W.chat_models = W.models.filter(function(m){
        return (m.mtype === 'text' || m.mtype === 'vision') && (m.model||'').trim();
      }).map(function(m){
        return {id:m.id, name:m.name, vision:!!m.vision, mtype:m.mtype, mtype_label:m.mtype_label};
      });
      W.image_models = W.models.filter(function(m){ return m.mtype === 'image'; })
        .map(function(m){ return {id:m.id, name:m.name, ready:!!(m.key_set && (m.url||'').trim())}; });
      W.video_models = W.models.filter(function(m){ return m.mtype === 'video'; })
        .map(function(m){ return {id:m.id, name:m.name, ready:!!(m.key_set && (m.url||'').trim())}; });
      W.capabilities = {image:W.image_models.length > 0, video:W.video_models.length > 0};
      var sel = $('#mChatModel');
      if(sel){
        var cur = sel.value;
        sel.innerHTML = W.chat_models.map(function(m){
          return '<option value="' + esc2(m.id) + '">' + esc2(m.name) + ' · ' + esc2(m.mtype_label) + '</option>';
        }).join('');
        if(cur) sel.value = cur;
      }
      document.dispatchEvent(new CustomEvent('modelschanged',{detail:{models:ms}}));
    });
  }
  function refreshAll(){ return Promise.all([loadModels(), loadUsage(), loadPresets()]); }
  document.addEventListener('riffcut-ready', refreshAll);

  /* 表单 */
  function setHint(txt,warn){
    var el=$('#mFormHint'); if(!el)return;
    el.textContent=txt; el.className='m-hint'+(warn?' warn':'');
  }
  function syncButtons(){
    /* 预设供应商现在真的能用：选中就自动填好接口地址，用户只补密钥。
       所以不再 disable 保存/测试按钮。 */
    var b=$('#mSaveBtn'); if(b) b.disabled=false;
    var t=$('#mTestBtn'); if(t) t.disabled=false;
  }

  /* ── 预设供应商：选中即填接口地址，并显示「去注册」入口 ── */
  var M_PRESETS = [];
  function presetByKey(k){
    for(var i=0;i<M_PRESETS.length;i++) if(M_PRESETS[i].key===k) return M_PRESETS[i];
    return null;
  }
  function loadPresets(){
    return A('/api/models',{action:'presets'}).then(function(r){
      M_PRESETS = (r && r.presets) || [];
      return M_PRESETS;
    }).catch(function(){ M_PRESETS = []; return []; });
  }
  function applyPreset(){
    var p=$('#mfPreset'); if(!p) return;
    var box=$('#mPresetBox'), ps=presetByKey(p.value);
    if(!ps){
      if(box) box.style.display='none';
      return;
    }
    /* 填接口地址与模型 ID。
       规则：空 → 直接填；当前值恰好等于「另一个预设的地址」→ 也覆盖。
       为什么后一条必须加：从白鹿切到 Agnes 时，白鹿的地址已经躺在框里了，
       只填空的话地址不会变 —— 用户以为在配 Agnes，key 却发去白鹿的服务器，
       报 401 还查不出原因。判断「是不是另一个预设的地址」而不是「用户改没改过」，
       是因为前者能精确区分「软件填的」和「人填的」。 */
    var u=$('#mfUrl');
    if(u){
      var cur=u.value.trim();
      var isOtherPreset = M_PRESETS.some(function(x){ return x.key!==ps.key && x.url && x.url===cur; });
      if(!cur || isOtherPreset) u.value = ps.url || '';
    }
    var m=$('#mfModel');
    if(m){
      var curm=m.value.trim();
      var isOtherModel = M_PRESETS.some(function(x){ return x.key!==ps.key && x.model && x.model===curm; });
      if(!curm || isOtherModel) m.value = ps.model || '';
    }
    var nm=$('#mfName'); if(nm && !nm.value.trim()) nm.value = ps.name || '';
    if($('#mfVision')) $('#mfVision').checked = !!ps.vision;
    if($('#mfImage')) $('#mfImage').checked = !!ps.image;

    if(box){
      box.style.display='';
      var e1=$('#mPresetName'); if(e1) e1.textContent = ps.name || ps.key;
      var e2=$('#mPresetVendor'); if(e2) e2.textContent = ps.vendor || 'OpenAI 兼容';
      var e3=$('#mPresetNote'); if(e3) e3.textContent = ps.note || '';
      /* 免费额度这一行是「要不要选这家」的决定性信息，放在说明文字上面、
         用绿色条框起来。没有 free 字段的（付费供应商）整行隐藏，不留空壳。 */
      var freeTag=$('#mPresetFree');
      if(freeTag) freeTag.style.display = ps.free ? '' : 'none';
      var freeLine=$('#mPresetFreeLine');
      if(freeLine){
        if(ps.free){
          freeLine.style.display='';
          freeLine.innerHTML='<svg class="ic"><use href="#i-spark"/></svg><span></span>';
          freeLine.querySelector('span').textContent = ps.free;
        }else{
          freeLine.style.display='none';
          freeLine.innerHTML='';
        }
      }
      var reg=$('#mPresetReg'); if(reg){
        reg.style.display = ps.register ? '' : 'none';
        /* Agnes 没有独立注册页，入口在登录页里的「Sign Up」，
           按钮文案得说清楚，不然用户点进去以为走错了 */
        reg.innerHTML = '<svg class="ic"><use href="#i-upload"/></svg>' +
          (ps.registerNote ? '去登录页注册（点 Sign Up）' : '去注册，拿 API Key');
      }
      var con=$('#mPresetConsole'); if(con) con.style.display = ps.console ? '' : 'none';
      var inv=$('#mPresetInvite');
      if(inv){
        /* 已经配了码就把它显示出来，只给占位提示等于让用户猜自己填没填对。
           显示的是当前生效值，改完点保存才覆盖。 */
        inv.value = ps.hasInvite ? (ps.invite || '') : '';
        inv.placeholder = '例如 INV-ABCD-1234，没有就留空';
      }
      var invRow=$('#mPresetInvite') ? $('#mPresetInvite').closest('.m-preset-inv') : null;
      if(invRow) invRow.style.display = ps.hasInvite || ps.key.indexOf('bailu')===0 ? '' : 'none';
    }
  }
  function syncKindHint(){
    var p=$('#mfPreset');
    var ps=p?presetByKey(p.value):null;
    if(ps){
      setHint('「'+ps.name+'」接口地址已自动填好。密钥要你自己去注册拿 —— 软件不内置任何密钥，'+
              '所以不会有人替你付调用费，也不会因为共用密钥被平台封号。点上面「去注册」拿 Key，'+
              '回来粘进 API Key 框，再点「测试连接」验证。',false);
      return;
    }
    var img=$('#mfImage')?$('#mfImage').checked:false;
    var vid=$('#mfVideo')?$('#mfVideo').checked:false;
    var on=$('#mfVision')?$('#mfVision').checked:false;
    setHint(img
      ? '生图模型：留在后台，不进首页下拉。AI 导演判断要出图时会自动调用它做封面 / Logo。⌘V 可粘贴。'
      : (vid
        ? '视频模型：留在后台，不进首页下拉。AI 导演判断要出视频时会自动调用它。⌘V 可粘贴。'
        : (on
          ? '多模态模型：能读图，会先总结你的提问、优化提示词，再按需调用后台生成模型。点「测试连接」会真发一张图，能不能读图由实测说话。⌘V 可粘贴。'
          : '文本模型：听懂需求、总结提问、写文案、排分镜，并按需调用后台生成模型。⌘V 可直接粘贴，也可点输入框旁的粘贴按钮；填错不会假装成功。')),false);
  }
  /* ── 读取可用模型：一个 Key 下可能有很多个，手动勾选要添加哪几个 ── */
  function scanReset(){
    M_STATE.scan = null;
    var b = $('#mScanBody'); if(b){ b.style.display='none'; b.innerHTML=''; }
    var sv = $('#mSaveBtn'); if(sv) sv.disabled = false;
  }
  function scanSelected(){
    var box = $('#mScanBody'); if(!box || !M_STATE.scan) return [];
    return [].slice.call(box.querySelectorAll('.m-scan-row')).filter(function(r){
      var c = r.querySelector('input[type=checkbox]');
      return c && c.checked && r.style.display !== 'none';
    }).map(function(r){
      var sel = r.querySelector('select');
      return {id:r.dataset.id, kind: sel ? sel.value : 'text'};
    });
  }
  function scanCount(){
    var n = scanSelected().length, el = $('#mScanCount'), b = $('#mScanAdd'), sv = $('#mSaveBtn');
    if(el) el.textContent = '已选 ' + n + ' 个';
    if(b){ b.textContent = '添加选中的 ' + n + ' 个模型'; b.disabled = !n; }
    if(sv) sv.disabled = !!n;   /* 有勾选时只走批量添加，避免误存一个空模型 */
  }
  function renderScan(){
    var box = $('#mScanBody'); if(!box || !M_STATE.scan) return;
    var sc = M_STATE.scan;
    var rows = sc.models.map(function(x){
      var kd = x.kind;
      return '<label class="m-scan-row" data-id="' + esc2(x.id) + '">' +
        '<input type="checkbox" checked>' +
        '<div class="sr-t"><b>' + esc2(x.id) + '</b><span>' + esc2(x.owned_by || '可用模型') + '</span></div>' +
        '<select>' +
          '<option value="text"' + (kd==='text'?' selected':'') + '>文本模型</option>' +
          '<option value="vision"' + (kd==='vision'?' selected':'') + '>多模态模型</option>' +
          '<option value="image"' + (kd==='image'?' selected':'') + '>生图模型</option>' +
          '<option value="video"' + (kd==='video'?' selected':'') + '>视频模型</option>' +
        '</select></label>';
    }).join('');
    box.innerHTML =
      '<div class="m-scan-top"><b>共 ' + sc.count + ' 个</b>' +
        '<div class="u-input"><input id="mScanSearch" placeholder="搜索模型 ID" spellcheck="false"></div>' +
        '<button type="button" data-scan="all">全选</button>' +
        '<button type="button" data-scan="none">清空</button></div>' +
      '<div class="m-scan-list" id="mScanList">' + rows + '</div>' +
      '<div class="m-scan-ft"><span class="m-note" id="mScanCount"></span>' +
        '<button type="button" class="u-btn sm gold" id="mScanAdd">添加选中的模型</button></div>' +
      '<div class="m-scan-hint">类型按模型 ID 猜，可改：文本 / 多模态 / 生图 / 视频。只有文本和多模态会进首页下拉。</div>';
    box.style.display = '';
    scanCount();
  }
  function fetchAvailable(){
    var f = formPayload();
    if(!f.url){ setHint('先填接口地址再读取可用模型',true); return; }
    if(!f.key){ setHint('先填 API Key 再读取可用模型',true); return; }
    var btn = $('#mFetchBtn');
    if(btn){ btn.disabled = true; btn.textContent = '正在读取…'; }
    setHint('正在向这个接口读取可用模型…',false);
    A('/api/models',{action:'fetch',url:f.url,key:f.key,vendor:f.vendor}).then(function(r){
      if(btn){ btn.disabled=false; btn.innerHTML='<svg class="ic"><use href="#i-refresh"/></svg>重新读取'; }
      /* window.api 已经剥掉外层 ok，直接给 data；这里要按 models 判断，不能再看 r.ok */
      if(!r || !r.models || !r.models.length){
        setHint('读取失败：接口没返回可用模型',true); return;
      }
      M_STATE.scan = {models:r.models||[], count:r.count||r.models.length,
                      url:f.url, key:f.key, vendor:f.vendor};
      renderScan();
      setHint('已读到 '+M_STATE.scan.count+' 个可用模型，勾选要添加的，再点「添加选中的模型」。',false);
    }).catch(function(e){
      if(btn){ btn.disabled=false; btn.innerHTML='<svg class="ic"><use href="#i-refresh"/></svg>读取可用模型'; }
      setHint('读取失败：'+e.message,true);
    });
  }
  function addSelected(){
    var picked = scanSelected();
    if(!picked.length){ setHint('还没勾选任何模型',true); return; }
    var f = formPayload();
    // 同接口 + 同模型 ID 已添加过的跳过，反复读取不会加出重复卡片
    var exist = {};
    Object.keys(M_STATE.models||{}).forEach(function(id){
      var m = M_STATE.models[id];
      if(m) exist[(m.url||'')+'|'+(m.model||'')] = 1;
    });
    var jobs = picked.filter(function(x){ return !exist[(f.url||'')+'|'+x.id]; }).map(function(x){
      var gen = (x.kind === 'image' || x.kind === 'video');
      return {id:'', name:x.id, kind:x.kind, vendor:f.vendor, url:f.url, key:f.key,
              model:x.id, chat:!gen, vision:x.kind==='vision',
              image:x.kind==='image', video:x.kind==='video',
              price:0, roles:[], fallback:''};
    });
    if(!jobs.length){ setHint('选中的模型都已经添加过了',false); return; }
    var btn = $('#mScanAdd');
    if(btn){ btn.disabled=true; btn.textContent='正在添加…'; }
    (function seq(i){
      if(i >= jobs.length){
        closeForm(); say('已添加 '+jobs.length+' 个模型');
        return refreshAll();
      }
      A('/api/models',{action:'save',model:jobs[i]}).then(function(){ seq(i+1); })
        .catch(function(e){
          setHint('添加「'+jobs[i].model+'」失败：'+e.message,true);
          if(btn){ btn.disabled=false; scanCount(); }
        });
    })(0);
  }

  function openForm(kind, id){
    var modal = $('#mModal'); if(!modal) return;
    M_STATE.editing = id || '';
    var m = id ? (M_STATE.models[id] || {}) : {};
    if($('#mFormTitle')) $('#mFormTitle').textContent = id ? ('编辑：' + (m.name||id)) : '添加模型';
    if($('#mfPreset')) $('#mfPreset').value = 'custom';
    /* 自绘下拉的按钮文字是独立的一行，赋值不会自动刷新 —— 手动同步一次 */
    if(window.__mfPresetSync) window.__mfPresetSync();
    if($('#mfName')) $('#mfName').value = m.name || '';
    if($('#mfVision')) $('#mfVision').checked = !!m.vision;
    if($('#mfImage')) $('#mfImage').checked = !!m.image;
    if($('#mfVideo')) $('#mfVideo').checked = !!m.video;
    if($('#mfVendor')) $('#mfVendor').value = (m.vendor||'').indexOf('Anthropic') >= 0 ? 'Anthropic 风格' : 'OpenAI 兼容';
    if($('#mfUrl')) $('#mfUrl').value = m.url || '';
    if($('#mfKey')) $('#mfKey').value = '';
    if($('#mfModel')) $('#mfModel').value = m.model || '';
    var sw = $('#mScanWrap'); if(sw) sw.style.display = id ? 'none' : '';
    scanReset();

    /* ★ 编辑预设卡（preset-auto / preset-bailu）时，把供应商下拉自动切到
       对应的预设，让「去注册拿 Key / 控制台」那两个按钮自己浮出来。
       不这么做的话，用户点「编辑」进来看到的是「自定义」，
       下拉里明明有白鹿却要自己找一遍 —— 那正是他要的那一步。 */
    if(id && m.preset && m.presetKey && $('#mfPreset')){
      var hasOpt = Array.prototype.some.call($('#mfPreset').options, function(o){ return o.value === m.presetKey });
      if(hasOpt){
        $('#mfPreset').value = m.presetKey;
        if(window.__mfPresetSync) window.__mfPresetSync();
        applyPreset();
      }
    }

    modal.classList.add('open');
    document.body.classList.add('modal-open');
    syncButtons();
    if(id) setHint('编辑中：改完点「保存并启用」。API Key 留空表示不修改。⌘V 可粘贴。',false);
    else syncKindHint();
    setTimeout(function(){var u=$('#mfUrl');if(u)u.focus();},60);
  }
  function closeForm(){
    var modal = $('#mModal'); if(modal) modal.classList.remove('open');
    document.body.classList.remove('modal-open');
    M_STATE.editing = '';
    scanReset();
  }
  function formPayload(){
    var model = $('#mfModel') ? $('#mfModel').value.trim() : '';
    var name = $('#mfName') ? $('#mfName').value.trim() : '';
    if(!name) name = model || '我的模型';
    var vision = $('#mfVision') ? $('#mfVision').checked : false;
    var image = $('#mfImage') ? $('#mfImage').checked : false;
    var video = $('#mfVideo') ? $('#mfVideo').checked : false;
    var gen = image || video;
    var d = {
      id: M_STATE.editing || '', name: name,
      kind: image ? 'image' : (video ? 'video' : (vision ? 'vision' : 'text')),
      vendor: $('#mfVendor') ? $('#mfVendor').value : 'OpenAI 兼容',
      url: $('#mfUrl') ? $('#mfUrl').value.trim() : '',
      model: model, chat: !gen, vision: vision, image: image, video: video, price: 0,
      roles: [], fallback: ''
    };
    var key = $('#mfKey') ? $('#mfKey').value.trim() : '';
    if(key) d.key = key;
    else if(M_STATE.editing && M_STATE.models[M_STATE.editing]) d.key = M_STATE.models[M_STATE.editing].key || '';
    return d;
  }
  function saveModel(){
    /* 预设供应商已经能直接保存：接口地址由 applyPreset 自动填好，
       这里只做「填完没有」的校验，不再拦截。 */
    var f = formPayload();
    if(!f.url){ say('先填接口地址（选预设供应商会自动填好）'); return Promise.reject(new Error('no url')); }
    if(!f.model){ say('先填模型 ID'); return Promise.reject(new Error('no model')); }
    return A('/api/models',{action:'save',model:f}).then(function(){
      closeForm(); say('模型「' + f.name + '」已保存到本机');
      return refreshAll();
    }).catch(function(e){ say(e.message); throw e; });
  }
  mark($$('#mSaveBtn'));$$('#mSaveBtn').forEach(function(b){b.addEventListener('click',function(){saveModel().catch(function(){})})});
  mark($$('#mCancelBtn'));$$('#mCancelBtn').forEach(function(b){b.addEventListener('click',closeForm)});
  mark($$('#mAddToggle'));$$('#mAddToggle').forEach(function(b){b.addEventListener('click',function(){openForm('','')})});
  mark($$('#mFetchBtn'));$$('#mFetchBtn').forEach(function(b){b.addEventListener('click',fetchAvailable)});
  var pSel = $('#mfPreset'); if(pSel) pSel.addEventListener('change',function(){
    applyPreset(); syncButtons(); syncKindHint();
  });

  /* 去注册 / 控制台：用主进程的 openExternal，走系统浏览器。
     注册链接里如果配了推广码会一起带上（见 models.js registerUrl）。 */
  mark($$('#mPresetReg'));$$('#mPresetReg').forEach(function(b){b.addEventListener('click',function(){
    var p=$('#mfPreset'); var ps=p?presetByKey(p.value):null;
    if(!ps||!ps.register){ say('这家没有配置注册地址'); return; }
    if(window.riffcut && window.riffcut.openExternal){
      window.riffcut.openExternal(ps.register).then(function(r){
        if(r&&r.ok) say('已在浏览器打开注册页，注册完把 API Key 粘进来就行');
        else say('打不开注册页：'+((r&&r.error)||'未知原因'));
      });
    } else { say('当前环境不支持打开外链'); }
  })});
  mark($$('#mPresetConsole'));$$('#mPresetConsole').forEach(function(b){b.addEventListener('click',function(){
    var p=$('#mfPreset'); var ps=p?presetByKey(p.value):null;
    if(!ps||!ps.console){ say('这家没有配置控制台地址'); return; }
    if(window.riffcut && window.riffcut.openExternal){
      window.riffcut.openExternal(ps.console).catch(function(){});
    }
  })});

  /* 保存推广码：写进 设置.json 的 preset_invites，之后注册链接自动带上 */
  mark($$('#mPresetInviteSave'));$$('#mPresetInviteSave').forEach(function(b){b.addEventListener('click',function(){
    var p=$('#mfPreset'); var ps=p?presetByKey(p.value):null;
    var el=$('#mPresetInvite');
    if(!ps||!el){ return; }
    A('/api/models',{action:'invite',preset:ps.key,code:el.value.trim()}).then(function(r){
      if(r && r.register) ps.register = r.register;
      ps.hasInvite = !!el.value.trim();
      say(el.value.trim() ? '推广码已保存，注册链接会带上它' : '推广码已清空，走官方注册页');
    }).catch(function(e){ say('保存失败：'+e.message); });
  })});
  var vSel = $('#mfVision'); if(vSel) vSel.addEventListener('change',syncKindHint);
  var iSel = $('#mfImage'); if(iSel) iSel.addEventListener('change',syncKindHint);
  var dSel = $('#mfVideo'); if(dSel) dSel.addEventListener('change',syncKindHint);

  /* 可用模型勾选列表：搜索 / 全选 / 改类型 / 批量添加 */
  var scanBody = $('#mScanBody');
  if(scanBody){
    scanBody.addEventListener('change',function(e){
      if(e.target.type === 'checkbox' || e.target.tagName === 'SELECT') scanCount();
    });
    scanBody.addEventListener('input',function(e){
      if(e.target.id !== 'mScanSearch') return;
      var q = e.target.value.trim().toLowerCase();
      [].slice.call(scanBody.querySelectorAll('.m-scan-row')).forEach(function(r){
        r.style.display = (!q || r.dataset.id.toLowerCase().indexOf(q) >= 0) ? '' : 'none';
      });
      scanCount();
    });
    scanBody.addEventListener('click',function(e){
      var b = e.target.closest('button'); if(!b) return;
      if(b.dataset.scan === 'all' || b.dataset.scan === 'none'){
        var on = b.dataset.scan === 'all';
        [].slice.call(scanBody.querySelectorAll('.m-scan-row')).forEach(function(r){
          if(r.style.display === 'none') return;
          var c = r.querySelector('input[type=checkbox]'); if(c) c.checked = on;
        });
        scanCount(); return;
      }
      if(b.id === 'mScanAdd'){ addSelected(); return; }
    });
  }
  var xBtn = $('#mCloseX'); if(xBtn) xBtn.addEventListener('click',closeForm);
  var mask = $('#mModal'); if(mask) mask.addEventListener('click',function(e){if(e.target===mask)closeForm();});
  document.addEventListener('keydown',function(e){
    if(e.key==='Escape'){var m=$('#mModal');if(m&&m.classList.contains('open'))closeForm();}
  });
  mark($$('#mRefresh'));$$('#mRefresh').forEach(function(b){b.addEventListener('click',function(){
    refreshAll().then(function(){say('模型与本地语音模型状态已刷新')});
  })});

  /* 测试连接：视觉类真发一张图，验证是不是真的能收图片；结果同时写进弹窗，不再只靠底部提示 */
  function showResult(msg,ok){ say(msg); setHint(msg,!ok); }
  mark($$('#mTestBtn'));$$('#mTestBtn').forEach(function(b){b.addEventListener('click',function(){
    var f = formPayload();
    if(!f.url){ showResult('先填接口地址再测试',false); return; }
    if(!f.model){ showResult('先填模型 ID 再测试',false); return; }
    if(!f.key){ showResult('先填 API Key 再测试',false); return; }
    showResult('正在真实连接测试…',true);
    /* 「测试」不能顺手把模型存进配置 —— 以前是 save 完再拿 id 去测，
       用户只是想验证一下地址对不对，结果列表里凭空多一条脏模型。
       现在先存一条临时记录（id 带 __probe 前缀），测完立刻删掉。 */
    A('/api/models',{action:'save',model:Object.assign({},f,{name:'__probe__ '+(f.name||'test')})})
      .then(function(saved){
      var id = saved && saved.id;
      if(!id) throw new Error('测试用临时模型没建起来');
      window.__probeId = id;
      return A('/api/models',{action:(f.vision?'test_vision':'test'),id:id});
    }).then(function(r){
      if(window.__probeId){
        A('/api/models',{action:'delete',id:window.__probeId}).catch(function(){});
        window.__probeId = null;
      }
      var ok = !!(r && r.ok);
      showResult(ok ? ('✓ 连接正常：'+(r.reply||'模型已响应'))
                    : ('✗ 连接失败：'+(r.error||'未知错误')),ok);
      return refreshAll();
    }).catch(function(e){
      /* 失败分支也要清临时模型，否则一次连不通就在列表里留一条脏记录 */
      if(window.__probeId){
        A('/api/models',{action:'delete',id:window.__probeId}).catch(function(){});
        window.__probeId = null;
      }
      showResult('✗ 连接失败：'+(e.message||'未知错误'),false);
    });
  })});

  /* 卡片里的编辑 / 测试 / 删除 */
  document.addEventListener('click',function(e){
    var pb = e.target.closest('[data-paste]');
    if(pb){
      var t = document.getElementById(pb.dataset.paste);
      if(t){
        if(navigator.clipboard && navigator.clipboard.readText){
          navigator.clipboard.readText().then(function(txt){
            if(txt && txt.trim()){window.__riffcutPaste(txt.trim(),t);say('已粘贴到输入框');}
            else{t.focus();say('剪贴板是空的，请按 ⌘V 粘贴');}
          }).catch(function(){t.focus();say('请按 ⌘V 粘贴（已支持）');});
        }else{t.focus();say('请按 ⌘V 粘贴（已支持）');}
      }
      return;
    }
    var btn = e.target.closest('#mGroups button[data-act]');
    if(btn){
      var id = btn.dataset.id, act = btn.dataset.act;
      if(act === 'edit'){
        /* ★ 2026-11-20 用户报「点编辑没反应」。
           以前这里对 preset 卡直接 return —— 本意是「内置卡不用编辑」，
           但用户要的正是「点进去改自己的 key、顺便拿注册链接」。
           现在放行：preset 卡也能编辑，openForm 会按 presetKey 自动选中
           对应预设，把「去注册拿 Key」的按钮带出来。 */
        openForm('', id);
      }
      if(act === 'test'){
        /* 测试按钮的实际处理在 renderModelGroups 里逐按钮直挂（见那边的注释）。
           这里不再重复发请求 —— 两套并存会打两次接口、闪两次提示。 */
        return;
      }
      if(act === 'del'){
        /* ★ 必须先弹确认框。以前这里直接 A('/api/models',{action:'delete'})
           —— 点一下模型就没了，没有二次确认、不能反悔。删模型是不可逆操作
           （密钥一起清掉、要重新填），必须让人明确点一次。 */
        var mm = M_STATE.models[id] || {};
        var nm = mm.name || id;
        var doDel = function(){
          A('/api/models',{action:'delete',id:id}).then(function(){
            say('已删除「'+nm+'」'); return refreshAll();
          }).catch(function(x){say('删除失败：'+((x&&x.message)||x))});
        };
        if(window.__confirmAsk){
          /* 传纯文本（不带 HTML 标签）：__confirmAsk 对纯文本会走 esc() 转义，
             模型名里万一有尖括号也不会破版。 */
          window.__confirmAsk('确定删除模型「'+nm+'」？它的 API Key 会一起清掉，要用得重新填。', doDel,
            { title:'删除模型', ok:'删除' });
        } else if(window.confirm){
          if(window.confirm('确定删除模型「'+nm+'」？API Key 会一起清掉。')) doDel();
        } else doDel();
      }
      return;
    }
    var add = e.target.closest('#mGroups button[data-add]');
    if(add){ openForm('', ''); return; }
  });

  /* 通用二次确认：普通操作点一次确认；危险操作必须输入指定文字（可点粘贴自动填）
     可选第二个按钮（o.altText / o.onAlt）：用于「只删记录」还是「连文件夹一起删」这种二选一 */
  var CONFIRM = {onOk:null, onAlt:null, phrase:''};
  function confirmAction(o){
    var modal=$('#mConfirmModal'); if(!modal)return;
    CONFIRM.onOk=o.onOk||null; CONFIRM.onAlt=o.onAlt||null; CONFIRM.phrase=o.phrase||'';
    var t=$('#mConfirmTitle'),x=$('#mConfirmText'),w=$('#mConfirmInputWrap'),
        inp=$('#mConfirmInput'),ok=$('#mConfirmOk'),alt=$('#mConfirmAlt');
    if(t)t.textContent=o.title||'确认操作';
    if(x)x.innerHTML=o.html||'';
    if(w)w.style.display=o.phrase?'':'none';
    if(inp)inp.value='';
    if(ok){ok.disabled=!!o.phrase;ok.textContent=o.okText||'确认';}
    if(alt){
      if(o.altText){alt.textContent=o.altText;alt.style.display='';
        alt.style.color=o.altDanger?'#B05252':'';}
      else{alt.style.display='none';}
    }
    modal.classList.add('open');
    document.body.classList.add('modal-open');
    if(o.phrase)setTimeout(function(){if(inp)inp.focus()},60);
  }
  /* 对外的简易确认入口：confirmAction 原本是 IIFE 里的局部函数，
     外部（shell 的会话删除、首页的各种二次确认）根本调不到，
     大家写的 window.__confirmAsk && window.__confirmAsk(...) 全是空转 ——
     点了删除什么都不发生，就是这个原因。
     这里暴露一个签名简单的适配器：(文案, 确认回调, {danger, ok}) */
  window.__confirmAsk=function(text,onOk,opt){
    opt=opt||{};
    /* ★ 纯文本参数必须转义。
       这个函数被用来拼「删除「<会话标题>」？」这类文案，而会话标题来自
       /api/conversations，用户可以用 prompt 改名 —— 标题里塞一段
       <img src=x onerror=...> 就能执行。
       只有显式传了 opt.html 才当成可信 HTML。 */
    var body = (opt && opt.html) ? String(opt.html) : esc(text);
    confirmAction({
      title:opt.title||'确认操作',
      html:'<div>'+body+'</div>',
      okText:opt.ok||'确认',
      /* 不给 altText：给了就会多冒出第二个「取消」，跟底部的取消键打架 */
      danger:!!opt.danger,
      onOk:onOk||null
    });
  };

  function closeConfirm(){
    var modal=$('#mConfirmModal'); if(modal)modal.classList.remove('open');
    document.body.classList.remove('modal-open');
    CONFIRM.onOk=null; CONFIRM.onAlt=null; CONFIRM.phrase='';
    var alt=$('#mConfirmAlt'); if(alt)alt.style.display='none';
  }
  mark($$('#mConfirmX'));$$('#mConfirmX').forEach(function(b){b.addEventListener('click',closeConfirm)});
  mark($$('#mConfirmCancel'));$$('#mConfirmCancel').forEach(function(b){b.addEventListener('click',closeConfirm)});
  var cInp=$('#mConfirmInput');
  if(cInp)cInp.addEventListener('input',function(){
    var ok=$('#mConfirmOk'); if(ok)ok.disabled=(cInp.value.trim()!==CONFIRM.phrase);
  });
  mark($$('#mConfirmPaste'));$$('#mConfirmPaste').forEach(function(b){
    b.addEventListener('click',function(){
      var inp=$('#mConfirmInput');
      if(inp){inp.value=CONFIRM.phrase;inp.dispatchEvent(new Event('input'));inp.focus();}
    });
  });
  mark($$('#mConfirmOk'));$$('#mConfirmOk').forEach(function(b){
    b.addEventListener('click',function(){
      var inp=$('#mConfirmInput');
      if(CONFIRM.phrase && (!inp || inp.value.trim()!==CONFIRM.phrase))return;
      var fn=CONFIRM.onOk; closeConfirm(); if(fn)fn();
    });
  });
  mark($$('#mConfirmAlt'));$$('#mConfirmAlt').forEach(function(b){
    b.addEventListener('click',function(){
      var inp=$('#mConfirmInput');
      if(CONFIRM.phrase && (!inp || inp.value.trim()!==CONFIRM.phrase))return;
      var fn=CONFIRM.onAlt; closeConfirm(); if(fn)fn();
    });
  });

  /* 用哪个模型由首页下拉统一决定，不再单独配任务路由 */

  /* ══════════ 07 · 模型使用量 概览（本机绑定模型的真实 token 用量） ══════════ */
  var U_STATE={period:'today',data:null,clearArmed:false};
  function uTok(n){
    n=Number(n)||0;
    if(n>=1e6)return (n/1e6).toFixed(1).replace(/\.0$/,'')+'M';
    if(n>=1e3)return (n/1e3).toFixed(1).replace(/\.0$/,'')+'K';
    return String(n);
  }
  function uDur(ms){ms=Number(ms)||0;return ms>=1000?(ms/1000).toFixed(1)+'s':ms+'ms'}
  function uTime(ts){return String(ts||'').slice(11,19)||'—'}
  function uClock(ep){
    if(!ep)return '—';
    var d=new Date(Number(ep)*1000);
    return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2);
  }
  function uCell(v,est){return (est?'<span class="est">~</span>':'')+uTok(v)}
  function uChart(buckets){
    buckets=buckets||[];
    var vals=buckets.map(function(b){return Number(b.tokens)||0});
    var max=Math.max.apply(null,vals.concat([1]));
    var W=720,pad=6,n=buckets.length;
    function draw(svg,base,top,gid){
      if(!svg)return;
      var grid='';
      [0.33,0.66,1].forEach(function(f){
        var y=(base-(base-top)*f).toFixed(1);
        grid+='<line x1="'+pad+'" y1="'+y+'" x2="'+(W-pad)+'" y2="'+y+
              '" stroke="#EEF1F5" stroke-width="1"/>';
      });
      var pts=vals.map(function(v,i){
        return [n<=1?W/2:pad+i*(W-2*pad)/(n-1), base-(v/max)*(base-top)];
      });
      /* 没有数据时 pts 是空的。以前这里直接拼字符串，得到 path="M6,22 L L714,22 Z"，
         浏览器报 "Malformed path data" —— 概览页一打开控制台就是红的。 */
      if(!pts.length){
        svg.innerHTML=grid+
          '<text x="'+(W/2)+'" y="'+((base+top)/2).toFixed(1)+'" text-anchor="middle" '+
          'fill="#9AA4B2" font-size="12">这段时间还没有调用记录</text>';
        return;
      }
      var line=pts.map(function(p){return p[0].toFixed(1)+','+p[1].toFixed(1)}).join(' ');
      var area='M'+pts[0][0].toFixed(1)+','+base+' L'+pts.map(function(p){
        return p[0].toFixed(1)+','+p[1].toFixed(1)}).join(' L')+
        ' L'+pts[pts.length-1][0].toFixed(1)+','+base+' Z';
      var dots=pts.map(function(p,i){
        return (i===pts.length-1||vals[i]>0)
          ? '<circle cx="'+p[0].toFixed(1)+'" cy="'+p[1].toFixed(1)+
            '" r="2.6" fill="#fff" stroke="#3569D6" stroke-width="1.6"/>' : '';
      }).join('');
      svg.innerHTML='<defs><linearGradient id="'+gid+'" x1="0" y1="0" x2="0" y2="1">'+
        '<stop offset="0%" stop-color="#3569D6" stop-opacity=".18"/>'+
        '<stop offset="100%" stop-color="#3569D6" stop-opacity="0"/></linearGradient></defs>'+
        grid+'<path d="'+area+'" fill="url(#'+gid+')"/>'+
        '<polyline points="'+line+'" fill="none" stroke="#3569D6" stroke-width="2" '+
        'stroke-linejoin="round" stroke-linecap="round"/>'+dots;
    }
    draw($('#mUsageChart'),22,4,'uGrad');   /* 详情里只留一条火花线，高度让给三张表 */
    draw($('#mUsageChartSmall'),52,8,'uGradSmall');
    var peak='峰值 '+uTok(Math.max.apply(null,vals.concat([0])));
    var pe=$('#mUsagePeak');if(pe)pe.textContent=peak;
    var ps=$('#mUsagePeakSmall');if(ps)ps.textContent=peak;
    var xs=$('#mUsageX');
    if(xs){
      var step=Math.max(1,Math.ceil(buckets.length/5));
      xs.innerHTML=buckets.filter(function(_,i){return i%step===0||i===buckets.length-1})
        .map(function(b){return '<span>'+esc2(b.label)+'</span>'}).join('');
    }
  }
  function rankRows(list){
    if(!list||!list.length)return '<tr><td colspan="5"><div class="m-empty2">这个周期还没有成功调用。</div></td></tr>';
    return list.map(function(r){
      return '<tr><td>'+esc2(r.name)+'</td><td class="t">'+r.requests+'</td>'+
        '<td class="in">'+uTok(r.in)+'</td><td class="out">'+uTok(r.out)+'</td>'+
        '<td class="t">'+uClock(r.last)+'</td></tr>';
    }).join('');
  }
  function renderUsage(d){
    U_STATE.data=d||{};
    var s=d.stats||{},recent=d.recent||[];
    var life=$('#mUsageLife');
    if(life)life.textContent='累计 '+(s.lifetime||0)+' 次调用';
    var note=$('#mUsageNote');
    if(note)note.textContent='总调用量永久保留：累计输入 '+uTok(s.lifetime_in||0)+
      ' / 输出 '+uTok(s.lifetime_out||0)+' TOKENS。'
      +'Token 取接口 usage；接口没给或数值异常大（>100 万）会按可见字符估算并标「~」，不照抄假数字。';
    var stats=$('#mUsageStats');
    if(stats){
      /* 概览只留 5 个面板；原来第 6 个「累计请求」改成下面的 Token 趋势条 */
      var cards=[
        ['总请求',String(s.requests||0),'成功率 '+(s.success_rate||0)+'%',''],
        ['输入 TOKENS',uTok(s.in),(s.estimated||0)+' 条为估算','blue'],
        ['输出 TOKENS',uTok(s.out),(s.failed||0)+' 次失败','green'],
        ['缓存命中率',(s.cache_hit_rate||0)+'%','命中 '+uTok(s.cached||0)+' / 输入 '+uTok(s.in||0),'gold'],
        ['平均耗时',uDur(s.avg_duration_ms),'本地缓存命中 '+(s.cache_hit||0)+' 次','']
      ];
      stats.innerHTML=cards.map(function(c){
        return '<div class="m-stat"><label>'+c[0]+'</label><b class="'+c[3]+'">'+c[1]+
               '</b><small>'+c[2]+'</small></div>';
      }).join('');
    }
    uChart(s.chart||[]);
    var rm=$('#mUsageRankModel');if(rm)rm.innerHTML=rankRows(s.by_model);
    var rs=$('#mUsageRankSupplier');if(rs)rs.innerHTML=rankRows(s.by_supplier);
    var rb=$('#mUsageRecent');
    if(rb){
      rb.innerHTML=recent.length?recent.map(function(r){
        var st=r.cache_hit?'缓存':(r.ok?'成功':'失败');
        if(r.usage_anomaly)st='接口值异常·已估算';
        return '<tr><td class="t">'+uTime(r.ts)+'</td>'+
          '<td title="'+esc2(r.model_ref||'')+'">'+esc2(r.model)+'</td>'+
          '<td>'+esc2(r.source)+(r.images?' · '+r.images+'帧':'')+'</td>'+
          '<td><span class="in">'+uCell(r.in,r.in_est)+'</span> / <span class="out">'+
          uCell(r.out,r.out_est)+'</span></td>'+
          '<td class="t">'+uDur(r.duration_ms)+'</td>'+
          '<td'+(r.ok?'':' class="bad"')+'><i class="dot'+(r.ok?'':' no')+'"></i>'+st+'</td></tr>';
      }).join(''):'<tr><td colspan="6"><div class="m-empty2">还没有调用记录。<br>'+
        '在首页聊天、测试连接或分析素材后，这里会显示每次调用真实消耗的 token。</div></td></tr>';
    }
  }
  function loadUsage(){
    return A('/api/usage',{action:'summary',period:U_STATE.period,limit:50})
      .then(function(d){renderUsage(d||{})})
      .catch(function(){renderUsage({stats:{},recent:[]})});
  }
  $$('#mUsageTabs button').forEach(function(b){
    b.addEventListener('click',function(){
      U_STATE.period=b.dataset.period||'today';
      $$('#mUsageTabs button').forEach(function(x){x.classList.toggle('on',x===b)});
      loadUsage();
    });
  });
  mark($$('#mUsageRefresh'));$$('#mUsageRefresh').forEach(function(b){
    b.addEventListener('click',function(){loadUsage().then(function(){say('调用记录已刷新')})});
  });
  /* 查看详情：弹出详细面板（趋势 + 两个表格 + 最近 50 条，面板内可滑动） */
  function openUsageDetail(){
    var m=$('#mUsageModal'); if(!m)return;
    m.classList.add('open'); document.body.classList.add('modal-open');
  }
  function closeUsageDetail(){
    var m=$('#mUsageModal'); if(!m)return;
    m.classList.remove('open'); document.body.classList.remove('modal-open');
  }
  mark($$('#mUsageDetail'));$$('#mUsageDetail').forEach(function(b){b.addEventListener('click',openUsageDetail)});
  mark($$('#mUsageDetailClose'));$$('#mUsageDetailClose').forEach(function(b){b.addEventListener('click',closeUsageDetail)});
  mark($$('#mUsageDetailDone'));$$('#mUsageDetailDone').forEach(function(b){b.addEventListener('click',closeUsageDetail)});
  /* 清空最近记录按钮已移除，绑定代码一并删掉 */
  /* 切到模型管理页时刷新一次；riffcut-ready 由 refreshAll 统一带一次 */
  $$('.nav a[data-page="models"]').forEach(function(a){
    a.addEventListener('click',function(){loadUsage()});
  });

  /* 08 · 模板与品牌库已改为真实数据页（/api/brand），接线在 08 页片段内，
     旧的浏览器原生输入框假接线一律删掉，避免和统一悬浮框双绑。 */

  /* ══════════ 09 · 任务中心 ══════════
     逻辑全部移到页面自身脚本（真实队列 / 日志 / 取消 / 重试 / 清空），
     这里不再重复绑定，避免同一次点击触发两套行为、写死的假任务覆盖真数据。 */

  /* ══════════ 10 · 系统设置 ══════════
     真实硬件 / FFmpeg / 隐私开关 / 法律协议与授权完整性全部移到 10 页自身脚本；
     这里不再绑定 .u-switch 与旧的「保存设置 / 恢复默认」假按钮。 */

  /* ══════════ 全局：一键成片 / 多版本 / 补镜头 / 翻译 / 发布 ══════════ */
  window.riffcutOneClick=function(){
    var root=(V().library||{}).root||'';if(!root){say('请先在首页选择素材文件夹');return}
    A('/api/one-click',{root:root,requirement:'一键成片'}).then(function(r){
      say('一键成片已入队');window.pollTask(r.task_id,function(res){
        document.dispatchEvent(new CustomEvent('renderdone',{detail:res||{}}))});
    });
  };
  window.riffcutMultiVersion=function(n){
    A('/api/multiversion',{count:n||3,requirement:'一次出多个版本'}).then(function(r){
      say('已提交 '+n+' 个版本的批量任务');window.pollTask(r.task_id);
    });
  };
  /* 剪辑链路的开机自检：统一交给 shell 的页眉告警（红色呼吸脉冲，一直挂着到修好）。
     这里不再 say —— 底部黑条 2 秒就没了，用户看不见，等点导出才失败。 */
  document.addEventListener('riffcut-ready',function(e){
    var d=e.detail||{};
    if(window.checkFfmpeg)window.checkFfmpeg(d.ffmpeg||{});
  });

  /* ══════════ 软件内升级 ══════════
     Swift 菜单「检查更新…」→ window.riffcutUpdate('check')
     全程只调本机 /api/update；替换发生在关窗之后，数据在 App 同级不受影响。 */
  function _updFail(e){say('升级没成：'+((e&&e.message)||'未知原因'))}
  function _updInstall(r){
    window.confirmAction({
      title:'新版本已下载并校验通过',
      html:'版本 <b>'+esc(r.version||'?')+'</b> · '+((r.bytes||0)/1048576).toFixed(1)+' MB'
        +'<br>sha256 '+esc(String(r.sha256||'').slice(0,20))+'…'
        +'<br><br>点「立即升级」后请关闭窗口，软件会自动替换并重新打开。'
        +'<br><span style="color:#888">旧版本会备份到 数据/系统/备份/，可回滚。</span>',
      okText:'立即升级',altText:'先不升级',
      onOk:function(){
        A('/api/update',{action:'install'}).then(function(x){
          /* ★ window.api() 已经 return j.data 了，这里再取 .data 必然是 undefined。
             以前这几处全写 x.data / d.data，结果每次都是空对象：
             检查更新永远说「已是最新版本」、下载永远「下载失败：」、
             安装和回滚永远「失败：」—— 升级功能等于不存在。 */
          var q=x||{};say(q.ok?(q.message||'已开始升级'):('失败：'+(q.error||'')));
        }).catch(_updFail);
      }
    });
  }
  /* ★ 启动时自动检查更新（原来这个开关是死的）
     踩过的坑：`check_on_start` 只被读写进 更新.json，全项目没有任何代码
     在启动时读过它 —— 用户把开关打开，也永远等不到「发现新版本」。
     现在补上：启动后延迟 8 秒查一次（别和首屏渲染抢），只在真有新版时提示，
     「已是最新」不弹窗，避免每次开机都被打扰。 */
  var _startChecked = false
  function _autoCheckOnStart(){
    if (_startChecked) return
    _startChecked = true
    A('/api/update',{action:'status'}).then(function(st){
      var s0 = st || {}
      if (!s0.enabled || !s0.check_on_start || !s0.feed_url) return
      return A('/api/update',{action:'check'}).then(function(r){
        var q = r || {}
        if (q.ok === false) return               // 连不上就不吵，用户下次手动点
        if (!q.has_update) return                // 已是最新：静默
        var rm = q.remote || {}, lo = q.local || {}
        window.confirmAction({
          title: '发现新版本 ' + esc(rm.version || '?'),
          html: '当前 ' + esc(lo.version || '?') + ' → 新版本 <b>' + esc(rm.version || '?') + '</b>'
            + '<br><br>' + esc(rm.notes || '（发布说明为空）')
            + '<br><br><span style="color:#888">只替换 App 本体，工程/素材/模型/密钥都不动。</span>',
          okText: '下载并安装', altText: '稍后再说',
          onOk: function(){ window.riffcutUpdate('download') }
        })
      })
    }).catch(function(){ /* 静默：启动检查失败不该弹错误框 */ })
  }
  /* 等首屏稳下来再查。用 readyState 判断，避免在 DOM 还没铺完时插对话框。 */
  if (document.readyState === 'complete') setTimeout(_autoCheckOnStart, 8000)
  else window.addEventListener('load', function(){ setTimeout(_autoCheckOnStart, 8000) })

  window.riffcutUpdate=function(action){
    if(action==='download'){
      say('正在下载新版本…');
      A('/api/update',{action:'download'}).then(function(d){
        var r=d||{};
        if(!r.ok){say('下载失败：'+(r.error||''));return;}
        _updInstall(r);
      }).catch(_updFail);
      return;
    }
    A('/api/update',{action:'check'}).then(function(d){
      var r=d||{};
      if(r.ok===false){say('检查失败：'+(r.error||''));return;}
      if(!r.has_update){say(r.reason||'已是最新版本');return;}
      var rm=r.remote||{},lo=r.local||{};
      window.confirmAction({
        title:'发现新版本 '+esc(rm.version||'?'),
        html:'当前版本 '+esc(lo.version||'?')+' → 新版本 <b>'+esc(rm.version||'?')+'</b>'
          +'<br><br>'+esc(rm.notes||'（发布说明为空）')
          +'<br><br><span style="color:#888">只替换 App 本体，工程/素材/模型/密钥都不动。</span>',
        okText:'下载并安装',altText:'稍后再说',
        onOk:function(){window.riffcutUpdate('download');}
      });
    }).catch(_updFail);
  };
  window.riffcutRollback=function(){
    window.confirmAction({
      title:'回滚到上一版本',
      html:'会把最近一次升级前的旧 App 换回来。<br>请确认当前版本有问题，然后关闭窗口完成回滚。',
      okText:'开始回滚',altText:'取消',
      onOk:function(){
        A('/api/update',{action:'rollback'}).then(function(x){
          var q=x||{};say(q.ok?(q.message||'已开始回滚'):('失败：'+(q.error||'')));
        }).catch(_updFail);
      }
    });
  };


  /* 顶栏的「当前客户」：旧版这个 span 从来没有代码去填，
     所以永远显示「未选择」——用户不知道自己在哪个客户下干活，
     切客户之后也没有任何提示。这里跟着 bootstrap 的结果补上。 */
  function paintCustomer(d){
    var el=document.getElementById('tbCustomer');
    if(!el)return;
    var n=(d&&(d.customer||(d.settings&&d.settings.customer)))||'';
    el.textContent=n?('当前客户：'+n):'当前客户：未选择';
    el.title=n?('素材、工程、成片都只在这个客户范围内读写'):'还没有选客户';
  }
  document.addEventListener('riffcut-ready',function(e){paintCustomer(e.detail)});
  if(window.RiffCut&&window.RiffCut.settings&&window.RiffCut.settings.customer)paintCustomer(window.RiffCut);

  /* 账户登录 / 注册整套已删除（2026-11-17 用户要求）：
     这个软件在本机跑，模型、素材、成片都在本地，账号除了打断创作没有别的作用。
     出片完成的「注册个账号」自动提醒也一并去掉。 */
})();
