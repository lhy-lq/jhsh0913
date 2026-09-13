/**
 * 建行生活 APP 每日签到 v2（请求快照重放版）
 * 适用：iOS Quantumult X
 *
 * ======================== 设计思路 ========================
 * 不硬编码建行的任何接口地址和参数（这就是老脚本失效的原因——
 * 接口一改就死）。本脚本把"签到请求"原样抓下来存到本地，
 * 之后每天由定时任务把这条请求原样重放，等于每天替你点一次签到。
 *
 * 只要手动签到能用，本脚本就能用；哪天失效了，重新抓一次即可。
 *
 * ======================== 工作流程 ========================
 * 1. 配置 QX 重写（见教程），打开建行生活 APP；
 * 2. 进入「会员有礼 → 签到」，手动点一次签到；
 *    脚本会自动捕获 APP 发出的请求并存入 QX 本地存储；
 *    收到「捕获成功」通知即抓取完成（含 autoLogin 登录请求会一并捕获）；
 * 3. 之后 QX 定时任务每天自动重放请求完成签到，弹通知播报结果。
 *
 * ======================== QX 配置 ========================
 * [rewrite_local]
 * ^https?:\/\/yunbusiness\.ccb\.com\/(clp_coupon|clp_service|basic_service)\/txCtrl\?txcode=(A3341A038|autoLogin|A3341SB06) url script-request-body https://你的脚本托管地址/ccb_life_sign_v2.js
 *
 * [task_local]
 * 17 7 * * * https://你的脚本托管地址/ccb_life_sign_v2.js, tag=建行生活, enabled=true
 *
 * [MITM]
 * hostname = yunbusiness.ccb.com
 *
 * 注意：QX 的脚本必须用 https 直链托管（GitHub/Gitee/自有服务器均可），
 *       把上面两处地址换成你自己的。
 *
 * 如果捕获不到请求（说明接口地址变了），请在 QX：设置→诊断→请求日志
 * 里找到你点「签到」时发出的请求，把其 URL 中 txcode= 后面的值替换
 * 到重写规则里对应位置即可。
 *
 * ======================== 其他 ========================
 * 多账号：每个账号分别手动签到一次即可，凭据自动累加。
 * 持久化键名：CCB_LIFE_SIGN_REQ（签到请求）、CCB_LIFE_LOGIN_REQ（登录请求）。
 * 仅限个人日常签到使用，请勿滥用。
 */

const KEY_SIGN = "CCB_LIFE_SIGN_REQ";
const KEY_LOGIN = "CCB_LIFE_LOGIN_REQ";
const MAX_ACCOUNTS = 5;
const TIMEOUT = 15000;

const TITLE = "建行生活签到";
const SUB = "v2 请求快照重放版";

// 不该原样重发的请求头
const HOP_HEADERS = [
  "content-length", "host", "accept-encoding",
  "connection", "transfer-encoding", "origin",
];

const $ = { name: "建行生活" }; // 占位，实际存储直接走 QX 的 $prefs

if (typeof $request !== "undefined") {
  capture(); // 抓包模式
} else {
  checkIn(); // 定时任务模式
}

/* ============================ 抓包 ============================ */

function capture() {
  try {
    const url = $request.url || "";
    const body = $request.body || "";
    const headers = filterHeaders($request.headers || {});

    if (!/txCtrl\?/.test(url)) return $done({});
    if (!body) return $done({}); // 空请求体不收

    const isLogin = /txcode=autoLogin/.test(url);

    // 提取账号标识：优先取 body 里的手机号/用户ID类字段
    const accountId = guessAccountId(body);
    const snapshot = { url: url, headers: headers, body: body, id: accountId, ts: Date.now() };

    const key = isLogin ? KEY_LOGIN : KEY_SIGN;
    const list = loadList(key);

    // 同一账号（body 相同）则覆盖，否则新增
    const idx = list.findIndex(function (it) { return it.body === body; });
    if (idx >= 0) {
      list[idx] = snapshot;
    } else {
      if (list.length >= MAX_ACCOUNTS) list.shift();
      list.push(snapshot);
    }
    $prefs.setValueForKey(JSON.stringify(list), key);

    notify(
      TITLE,
      SUB,
      "🎉 签到数据捕获成功" +
        "\n类型：" + (isLogin ? "登录请求(autoLogin)" : "签到请求") +
        "\n账号：" + (accountId || "默认") +
        "\n已存 " + list.length + " 份数据"
    );
    $done({});
  } catch (e) {
    notify(TITLE, SUB, "❌ 捕获出错：" + e);
    $done({});
  }
}

function filterHeaders(headers) {
  const out = {};
  for (const k in headers) {
    if (HOP_HEADERS.indexOf(k.toLowerCase()) >= 0) continue;
    out[k] = headers[k];
  }
  return out;
}

function guessAccountId(body) {
  try {
    const m = body.match(/"?(mobileNo|phoneNo|mobile|mebId|userId|userNo|MEB_ID)"?\s*[:=]\s*"?([\w@.-]{4,})"?/i);
    return m ? m[2] : "";
  } catch (e) { return ""; }
}

function loadList(key) {
  const raw = $prefs.valueForKey(key);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

/* ============================ 签到 ============================ */

function checkIn() {
  const signList = loadList(KEY_SIGN);
  if (signList.length === 0) {
    notify(TITLE, SUB, "⚠️ 未找到签到数据\n请先按教程：打开建行生活APP手动签到一次完成捕获");
    return $done();
  }

  const loginList = loadList(KEY_LOGIN);
  let finished = 0;
  const results = [];

  signList.forEach(function (snap, i) {
    const afterLogin = function (loginMsg) {
      replay(snap, function (ok, text, raw) {
        results.push(
          "【账号" + (i + 1) + (snap.id ? " " + snap.id : "") + "】" +
          (ok ? "✅ " : "❌ ") + text + (loginMsg ? "\n(" + loginMsg + ")" : "")
        );
        finished++;
        if (finished === signList.length) {
          notify(TITLE, SUB, results.join("\n———\n"));
          $done();
        }
      });
    };

    // 若捕获过登录请求，先重放登录刷新会话
    const loginSnap = loginList.length > 0 ? loginList[Math.min(i, loginList.length - 1)] : null;
    if (loginSnap) {
      replay(loginSnap, function (ok, text) {
        afterLogin(ok ? "" : "登录刷新失败：" + text);
      });
    } else {
      afterLogin("");
    }
  });
}

function replay(snap, callback) {
  const opt = {
    url: snap.url,
    method: "POST",
    headers: snap.headers,
    body: snap.body,
    timeout: TIMEOUT,
  };
  $task.fetch(opt).then(
    function (resp) {
      const parsed = parseResponse(resp.body || "");
      callback(parsed.ok, parsed.text, resp.body);
    },
    function (reason) {
      callback(false, "请求失败 " + (reason && reason.error ? reason.error : ""));
    }
  );
}

/* -------- 响应解析：不绑定具体接口字段，做通用启发式判断 -------- */

function parseResponse(raw) {
  // 显式的成功/重复签到关键词
  if (/已签到|今日已签|重复签到|签过/.test(raw)) return { ok: true, text: "今日已签到（无需重复）" };
  if (!raw) return { ok: false, text: "响应为空" };

  let json = null;
  try { json = JSON.parse(raw); } catch (e) { /* 可能是加密/非JSON响应 */ }

  if (json === null) {
    // 非JSON：拿前80字符供排查
    const head = raw.replace(/\s+/g, " ").slice(0, 80);
    return { ok: false, text: "非JSON响应: " + head };
  }

  const code = deepGet(json, ["rspCode", "retCode", "returnCode", "resultCode", "errCode", "errorCode", "code", "status"]);
  const msg = deepGet(json, ["rspDesc", "retMsg", "returnMsg", "errMsg", "errorMsg", "message", "msg", "desc"]) || "";

  const okCodes = ["0", "000000", "0000", "00", "200", "success", "SUCCESS", "Success", "S"];
  const ok = code !== null && okCodes.indexOf(String(code)) >= 0;

  // 尝试提取签到天数/奖励信息
  const extra = [];
  const day = deepGet(json, ["signDay", "signDays", "continueDays", "totalDays", "days"]);
  if (day !== null) extra.push("天数:" + day);
  const prize = deepGet(json, ["prizeName", "awardName", "couponName", "giftName"]);
  if (prize !== null) extra.push("奖励:" + prize);

  let text = (msg || (ok ? "成功" : "失败")) + (code !== null ? " [code=" + code + "]" : "");
  if (extra.length) text += " " + extra.join(" ");
  if (!ok) text += "\n" + raw.replace(/\s+/g, " ").slice(0, 100);

  return { ok: ok, text: text };
}

// 在任意深度的 JSON 里找第一个命中的字段值
function deepGet(obj, keys) {
  try {
    for (const k of keys) {
      const v = findKey(obj, k);
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return null;
  } catch (e) { return null; }
}

function findKey(obj, key) {
  if (obj === null || typeof obj !== "object") return undefined;
  if (Array.isArray(obj)) {
    for (const it of obj) {
      const v = findKey(it, key);
      if (v !== undefined) return v;
    }
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const k in obj) {
    const v = findKey(obj[k], key);
    if (v !== undefined) return v;
  }
  return undefined;
}

/* ============================ 工具 ============================ */

function notify(title, subtitle, body) {
  if (typeof $notification !== "undefined") $notification.post(title, subtitle, body);
  if (typeof console !== "undefined") console.log(title + " | " + subtitle + " | " + body);
}
