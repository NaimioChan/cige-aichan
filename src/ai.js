"use strict";
/* ================= 词格酱 · AI 填词模块 =================
   支持任意「OpenAI 兼容」接口（各种中转站基本都是这个格式）：
   POST {base}/chat/completions，body 里 model + messages，Authorization: Bearer <key>。

   面板的四个设置（BASE_URL / API_KEY / MODEL / 风格提示词）都只存本机
   localStorage（cige.ai.v1），不进工程文件、不导出、不上传。

   填词流水线（fillLine 循环）：
   1. 拼系统提示词：全曲设定 + 本句词格（逐分句的格数和已填内容）+ 用户风格提示词
   2. 请求 AI 返回 JSON：{ line: "逐分句用空格分隔的填词", note: "一句话说明思路" }
   3. 本地校验：按 CL()（跟主程序同一套拗音/浊点拼格规则）数每个分句的字数，
      对不上就带着具体错误信息再发给 AI，最多重试 3 次
   4. 全部通过才写回 state，绝不写一句字数不对的词进词格
   「检查全篇」同理：整首歌一起交给 AI 审（押韵/意象/连贯），返回逐句替换建议，
   同样逐句本地校验格数，不合格的句子自动丢弃、只保留改对了的。
*/

const AI_STORE_KEY = "cige.ai.v1";

/* ---------- 设置（只存本机） ---------- */
let aiCfg = { baseUrl: "", apiKey: "", model: "", style: "", maxTokens: 3000, temperature: 0.9 };
try{
  const s = localStorage.getItem(AI_STORE_KEY);
  if(s){ const o = JSON.parse(s); if(o && typeof o === "object") aiCfg = Object.assign(aiCfg, o); }
}catch(e){}

function aiSaveCfg(){
  try{ localStorage.setItem(AI_STORE_KEY, JSON.stringify(aiCfg)); }catch(e){}
}

function aiNormBase(url){
  url = String(url || "").trim().replace(/\/+$/, "");
  if(url && !/\/chat\/completions$/.test(url) && !/\/v\d+(\/|$)/.test(url)) url += "/v1";
  return url;
}

/* ---------- 与主程序共享的格子计数（index.html 里定义，这里只引用） ---------- */
/* cap / CL / RT / state / t / toast / render / redrawRow 均由 index.html 提供 */

/* ---------- 请求 ---------- */
function aiHeaders(){
  return {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + aiCfg.apiKey
  };
}

async function aiChat(messages, opts){
  const base = aiNormBase(aiCfg.baseUrl);
  if(!base) throw new Error(t("aiErrNoBaseUrl"));
  if(!aiCfg.apiKey) throw new Error(t("aiErrNoKey"));
  const body = {
    model: aiCfg.model,
    messages,
    temperature: (opts && opts.temperature !== undefined) ? opts.temperature : aiCfg.temperature,
    stream: false
  };
  if(aiCfg.maxTokens) body.max_tokens = aiCfg.maxTokens;
  let resp;
  try{
    resp = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: aiHeaders(),
      body: JSON.stringify(body)
    });
  }catch(e){
    throw new Error(t("aiErrNetwork") + e.message);
  }
  if(!resp.ok){
    let detail = "";
    try{ const j = await resp.json(); detail = (j.error && (j.error.message || j.error.code)) || JSON.stringify(j).slice(0, 300); }
    catch(e){ try{ detail = (await resp.text()).slice(0, 300); }catch(e2){} }
    throw new Error(t("aiErrHttp", resp.status, detail));
  }
  const data = await resp.json();
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  const text = msg && typeof msg.content === "string" ? msg.content
    : (msg && Array.isArray(msg.content) ? msg.content.map(c => c.text || "").join("") : "");
  if(!text) throw new Error(t("aiErrEmpty"));
  return text;
}

/* 从回复里抠 JSON（容错：剥 ```json 代码栅栏、截取第一个 { 到最后一个 }） */
function aiParseJson(text){
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if(fence) s = fence[1].trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if(a >= 0 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s);
}

/* ---------- 提示词 ---------- */
function aiSongBrief(){
  const secs = state.sections.map(sec => {
    const lines = sec.lines.map(L => {
      const cl = CL(RT(L.t)), C = cap(L);
      const parts = [];
      let i = 0;
      for(const n of L.g){
        const seg = [];
        for(let k = 0; k < n; k++){ const c = cl[i]; seg.push(c !== undefined && c !== " " && c !== "　" ? c : "□"); i++; }
        parts.push(seg.join(""));
      }
      return L.g.join("/") + "：" + parts.join(" ");
    }).join("\n");
    return "【" + sec.name + "】\n" + lines;
  }).join("\n\n");
  return "《" + (state.title || t("untitled")) + "》\n" + secs;
}

function aiSystemPrompt(){
  let p = "你是一位中文歌词创作助手，正在「词格酱」里按固定词格填词。词格就是作曲定好的旋律骨架："
    + "每句的格子数是死的，多一字少一字都不行；分句（用 / 分隔，如 2/2/3）是句内的停顿分组。"
    + "「□」表示这一格还空着，需要你填上；已经有字的格子原则上保留，除非用户要求改写。"
    + "\n\n硬性规则（违反任何一条都算失败）："
    + "\n1. 每个字占一格，一个格子不多不少正好一个汉字（或一个英文字母/数字/假名）——"
    + "英文字母和数字也按字符数占格，不要把一个单词塞进一格。"
    + "\n2. 标点符号占格。如果一个停顿分组还剩最后一格且用户没要求标点，优先填字而不是标点。"
    + "\n3. 返回的 line 里，各分句之间用一个空格分隔，分句内部的字必须连写（内部不要加空格）。"
    + "\n4. 输出必须是严格的 JSON：{\"line\":\"...\",\"note\":\"...\"}，不要输出 JSON 之外的任何文字。"
    + "\n\n创作要求：口语自然、能唱，避免生硬的书面腔；注意句与句之间的衔接和全曲意象的统一。";
  if(aiCfg.style.trim()) p += "\n\n用户的风格要求（必须遵守）：\n" + aiCfg.style.trim();
  return p;
}

/* 每个分句的格数和当前内容，都摊平成提示词里的一行 */
function aiLineBrief(L){
  const cl = CL(RT(L.t)), C = cap(L);
  const parts = [];
  let i = 0;
  for(const n of L.g){
    const seg = [];
    for(let k = 0; k < n; k++){ const c = cl[i]; seg.push(c === undefined || c === " " || c === "　" ? "□" : c); i++; }
    parts.push(seg.join(""));
  }
  return L.g.join("/") + "：" + parts.join(" ");
}

/* ---------- 本地校验：返回 null 表示通过，否则返回错误说明（喂回给 AI 重试） ---------- */
function aiCheckFill(text, g){
  const parts = String(text).trim().split(/\s+/).filter(Boolean);
  if(parts.length !== g.length)
    return t("aiCheckSegCount", parts.length, g.length);
  for(let i = 0; i < g.length; i++){
    const cl = CL(parts[i]);
    if(cl.length !== g[i])
      return t("aiCheckSegLen", i + 1, cl.length, g[i], parts[i]);
  }
  return null;
}

/* 把「分句间空格分隔」的文本写回一句（格子钉死的规则跟手填一致：多余截掉、不足留空） */
function aiApplyLineText(L, text){
  const parts = text.split(/\s+/).filter(Boolean);
  let out = "";
  let i = 0;
  for(let gi = 0; gi < L.g.length; gi++){
    const cl = CL(parts[gi] || "");
    for(let k = 0; k < L.g[gi]; k++){
      const c = cl[k] !== undefined ? cl[k] : " ";
      out += c;
    }
    i += L.g[gi];
  }
  L.t = out;
}

/* ---------- 单句 AI 填词（含校验-重试循环） ---------- */
const AI_MAX_RETRY = 3;

async function aiFillLine(sec, L){
  const messages = [
    { role: "system", content: aiSystemPrompt() },
    { role: "user", content:
        "全曲词格与当前进度（□ 是空格，每句开头的 2/2/3 是分句格数）：\n\n" + aiSongBrief() +
        "\n\n现在只处理这一句（词格 " + L.g.join("/") + "）：\n" + aiLineBrief(L) +
        "\n\n请把这一句的空格 □ 填上。全句已填满、或你判断现有文字已经足够好时，可以原样返回（不要硬改）。" +
        "\nnote 里用一句话说明你的填写思路。" }
  ];
  let lastErr = "";
  for(let attempt = 0; attempt <= AI_MAX_RETRY; attempt++){
    const msgs = messages.slice();
    if(lastErr) msgs.push({ role: "user", content: t("aiRetryPrompt", lastErr) });
    const raw = await aiChat(msgs);
    let j;
    try{ j = aiParseJson(raw); }
    catch(e){ lastErr = t("aiCheckJson"); continue; }
    const line = typeof j.line === "string" ? j.line : (typeof j === "string" ? j : "");
    const chk = aiCheckFill(line, L.g);
    if(chk === null){ return { text: line, note: typeof j.note === "string" ? j.note : "" }; }
    lastErr = chk;
  }
  throw new Error(t("aiErrNotFit", AI_MAX_RETRY + 1, lastErr));
}

/* ---------- 整首填 / 整首检查 ---------- */
let aiBusy = false;

function aiSetBusy(b, msg){
  aiBusy = b;
  const btn = $("#aigo");
  if(btn){ btn.disabled = b; btn.textContent = b ? (msg || t("aiWorking")) : t("aiGo"); }
  const chk = $("#aichk");
  if(chk) chk.disabled = b;
}

async function aiRunAll(mode){
  if(aiBusy) return;
  if(!aiNormBase(aiCfg.baseUrl) || !aiCfg.apiKey || !aiCfg.model){
    aiOpenPanel();
    toast(t("aiToastNeedCfg"));
    return;
  }
  const hasEmpty = state.sections.some(sec => sec.lines.some(L => {
    const cl = CL(RT(L.t));
    return cl.length < cap(L);
  }));
  if(mode === "fill" && !hasEmpty && !confirm(t("aiConfirmAllFilled"))){ return; }

  aiSaveCfg();
  aiSetBusy(true, mode === "fill" ? t("aiWorkingFill") : t("aiWorkingCheck"));
  const startedAt = Date.now();
  let ok = 0, skip = 0, notes = [];
  try{
    if(mode === "fill"){
      const todo = [];
      state.sections.forEach((sec, si) => sec.lines.forEach((L, li) => {
        if(CL(RT(L.t)).length < cap(L)) todo.push({ sec, L, si, li });
      }));
      for(const item of todo){
        aiSetBusy(true, t("aiProgress", item.si + 1, item.li + 1));
        try{
          const r = await aiFillLine(item.sec, item.L);
          aiApplyLineText(item.L, r.text);
          if(r.note) notes.push(t("aiNoteLine", item.si + 1, item.li + 1) + " " + r.note);
          ok++;
          render();
        }catch(e){
          skip++;
          notes.push(t("aiNoteLine", item.si + 1, item.li + 1) + " " + t("aiSkipFail", e.message));
        }
      }
    }else{
      /* 检查/润色：整首一起交给 AI 审，返回逐句建议，逐句本地校验后才采用 */
      aiSetBusy(true, t("aiWorkingCheck"));
      const messages = [
        { role: "system", content: aiSystemPrompt() },
        { role: "user", content:
            "这是当前的歌词工程（每句开头是分句格数，□ 是空格）：\n\n" + aiSongBrief() +
            "\n\n请通读全篇，从押韵、意象、口吻、叙事连贯的角度，挑出值得改写的句子并给出替换文本。" +
            "\n只改确实更好的句子，不要为了改而改；替换文本必须严格符合该句词格。" +
            "\n输出 JSON：{\"suggestions\":[{\"sec\":段落序号(从1起),\"line\":句序号(段内从1起),\"text\":\"替换文本(分句间用空格分隔)\",\"why\":\"一句话理由\"}]}。" +
            "\n没有值得改的就返回 {\"suggestions\":[]}。" }
      ];
      const raw = await aiChat(messages);
      let j;
      try{ j = aiParseJson(raw); }
      catch(e){ throw new Error(t("aiCheckJson")); }
      const sug = Array.isArray(j.suggestions) ? j.suggestions : [];
      for(const s of sug){
        const sec = state.sections[(s.sec | 0) - 1];
        const L = sec && sec.lines[(s.line | 0) - 1];
        if(!L) continue;
        const chk = aiCheckFill(s.text, L.g);
        if(chk !== null){ skip++; notes.push(t("aiNoteLine", s.sec, s.line) + " " + t("aiSkipFail", chk)); continue; }
        const parts = s.text.trim().split(/\s+/);
        const oldText = RT(L.t) || t("versionEmpty");
        aiApplyLineText(L, s.text);
        if(s.why) notes.push(t("aiNoteLine", s.sec, s.line) + " " + oldText + " → " + RT(L.t) + "（" + s.why + "）");
        ok++;
      }
      render();
    }
  }catch(e){
    toast(t("aiToastFail", e.message));
  }finally{
    aiSetBusy(false);
    render();
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    const summary = mode === "fill" ? t("aiDoneFill", ok, skip, secs) : t("aiDoneCheck", ok, skip, secs);
    if(notes.length){
      aiLog(summary + "\n" + notes.join("\n"));
      toast(t("aiToastSeeLog"));
    }else{
      aiLog(summary);
      toast(summary);
    }
    save();
  }
}

/* ---------- 运行日志 ---------- */
function aiLog(msg){
  const box = $("#ailog");
  if(!box) return;
  const stamp = new Date().toLocaleTimeString(LOCALE[state.lang] || "zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const row = el("div", "ailog-row");
  row.textContent = "[" + stamp + "] " + msg;
  box.insertBefore(row, box.firstChild);
  while(box.children.length > 40) box.removeChild(box.lastChild);
}

/* ---------- 面板 UI ---------- */
function aiOpenPanel(){ $("#aip").classList.add("show"); aiSyncPanel(); }
function aiClosePanel(){ $("#aip").classList.remove("show"); }

function aiSyncPanel(){
  $("#aiurl").value = aiCfg.baseUrl;
  $("#aikey").value = aiCfg.apiKey;
  $("#aimodel").value = aiCfg.model;
  $("#aistyle").value = aiCfg.style;
  $("#aimax").value = aiCfg.maxTokens;
  $("#aimaxv").textContent = aiCfg.maxTokens;
  $("#aitemp").value = aiCfg.temperature;
  $("#aitempv").textContent = Number(aiCfg.temperature).toFixed(1);
  $("#aigo").disabled = aiBusy;
  $("#aichk").disabled = aiBusy;
}

function aiBind(){
  const inp = (sel, key, num) => $(sel).addEventListener("input", e => {
    aiCfg[key] = num ? +e.target.value : e.target.value;
    aiSaveCfg();
  });
  inp("#aiurl", "baseUrl");
  inp("#aikey", "apiKey");
  inp("#aimodel", "model");
  $("#aistyle").addEventListener("input", e => { aiCfg.style = e.target.value; aiSaveCfg(); });
  $("#aimax").addEventListener("input", e => { aiCfg.maxTokens = +e.target.value; $("#aimaxv").textContent = e.target.value; aiSaveCfg(); });
  $("#aitemp").addEventListener("input", e => { aiCfg.temperature = +e.target.value; $("#aitempv").textContent = Number(e.target.value).toFixed(1); aiSaveCfg(); });

  $("#aibtn").onclick = () => { if($("#aip").classList.contains("show")) aiClosePanel(); else aiOpenPanel(); };
  $("#aiclose").onclick = aiClosePanel;
  $("#aip").onclick = e => { if(e.target.id === "aip") aiClosePanel(); };
  $("#aigo").onclick = () => aiRunAll("fill");
  $("#aichk").onclick = () => aiRunAll("check");

  /* Escape 关面板，跟 help/exp/bgp 一致 */
  document.addEventListener("keydown", e => {
    if(e.key === "Escape" && $("#aip").classList.contains("show")) aiClosePanel();
  });
}

/* 帮助面板里追加一段 AI 说明（i18n key：aiHelp*)，DOMContentLoaded 时由 index.html 触发 */
function aiInjectHelp(){
  const anchor = document.querySelector("#help .card .credit");
  if(!anchor) return;
  const h4 = el("h4"); h4.dataset.i18n = "aiHelpH4"; h4.textContent = t("aiHelpH4");
  const p1 = el("p"); p1.dataset.i18n = "aiHelpP1"; p1.innerHTML = t("aiHelpP1");
  const p2 = el("p"); p2.dataset.i18n = "aiHelpP2"; p2.innerHTML = t("aiHelpP2");
  anchor.parentNode.insertBefore(h4, anchor);
  anchor.parentNode.insertBefore(p1, anchor);
  anchor.parentNode.insertBefore(p2, anchor);
}
