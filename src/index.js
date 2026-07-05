/**
 * GR0UT — Notif batailles Carte Globale (Cloudflare Worker).
 *
 * Remplace le bot GitHub Actions (dont le cron n'était lancé qu'~1×/h par
 * GitHub). Ici le Cron Trigger Cloudflare est FIABLE (toutes les 5 min).
 *
 * - Source des batailles : wot/globalmap/clanbattles (batailles réellement
 *   programmées, division posée) -> maps + heures exactes (timestamp unix).
 * - Suivi des provinces gagnées/perdues (clanprovinces).
 * - État (anti-doublon + provinces) stocké dans KV.
 *
 * Vars : CLAN_ID, CW_ROLE_ID. Secrets : WG_APP_ID, DISCORD_WEBHOOK_URL, RUN_SECRET.
 * KV : STATE.
 */

const WG = "https://api.worldoftanks.eu";
const CDN = "https://eu-wotp.wgcdn.co/dcont/fb/image";
const MAP_OVERRIDES = { "34_redshire": `${CDN}/redshire.png`, "23_westfeld": `${CDN}/westfield.png` };
const LEAD_MIN = 15;   // minutes : plancher bas (manches de tournoi tardives)
const LEAD_MAX = 90;
const ROLE = {
  Attaque: { emoji: "⚔️", color: 0xE74C3C },
  Défense: { emoji: "🛡️", color: 0x3498DB },
  Bataille: { emoji: "•", color: 0x2ECC71 },
};
const TRANSIENT = new Set(["SOURCE_NOT_AVAILABLE", "REQUEST_LIMIT_EXCEEDED"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- API Wargaming -----------------------------------------------------------

async function wgGet(env, path, params) {
  const url = new URL(`${WG}/${path}/`);
  url.searchParams.set("application_id", env.WG_APP_ID);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  let last;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(url);
      const j = await r.json();
      if (j.status === "ok") return j.data;
      last = new Error(j.error?.message || "api error");
      if (!TRANSIENT.has(j.error?.message)) throw last;
    } catch (e) { last = e; }
    await sleep(1000 * (a + 1));
  }
  throw last;
}

async function activeFronts(env) {
  const f = await wgGet(env, "wot/globalmap/fronts", {});
  return (f || []).filter((x) => x.is_active).map((x) => x.front_id);
}

async function clanTags(env, ids) {
  const uniq = [...new Set(ids.filter(Boolean).map(String))];
  const tags = {};
  for (let i = 0; i < uniq.length; i += 100) {
    const data = await wgGet(env, "wgn/clans/info",
      { clan_id: uniq.slice(i, i + 100).join(","), fields: "tag,name" });
    for (const [cid, info] of Object.entries(data || {}))
      if (info) tags[cid] = info.tag || info.name || cid;
  }
  return tags;
}

const imgCache = {};
async function mapImage(arenaId) {
  if (!arenaId) return null;
  if (arenaId in imgCache) return imgCache[arenaId];
  const url = MAP_OVERRIDES[arenaId] || `${CDN}/${arenaId}.png`;
  let ok = null;
  try {
    const r = await fetch(url);
    if (r.ok && (r.headers.get("content-type") || "").startsWith("image")) ok = url;
  } catch (e) { /* pas d'image */ }
  imgCache[arenaId] = ok;
  return ok;
}

// --- Batailles (clanbattles) -------------------------------------------------

async function collectBattles(env) {
  const raw = await wgGet(env, "wot/globalmap/clanbattles", { clan_id: env.CLAN_ID });
  if (!raw || !raw.length) return [];
  const byFront = {};
  for (const b of raw) (byFront[b.front_id] = byFront[b.front_id] || new Set()).add(b.province_id);
  const arena = {};
  for (const [front, pids] of Object.entries(byFront)) {
    const data = await wgGet(env, "wot/globalmap/provinces",
      { front_id: front, province_id: [...pids].join(","), limit: 100 });
    for (const p of (data || [])) arena[p.province_id] = [p.arena_id, p.arena_name];
  }
  return raw.map((b) => {
    const [aid, aname] = arena[b.province_id] || [null, null];
    return {
      provinceId: b.province_id, provinceName: b.province_name,
      arenaId: aid, arenaName: aname || b.province_name,
      start: b.time * 1000,
      role: { attack: "Attaque", defense: "Défense" }[b.type] || "Bataille",
      opponents: b.competitor_id ? [b.competitor_id] : [],
    };
  });
}

// --- Provinces (gains / pertes) ----------------------------------------------

async function ownedProvinces(env) {
  const owned = {};
  for (const front of await activeFronts(env)) {
    const d = await wgGet(env, "wot/globalmap/clanprovinces",
      { clan_id: env.CLAN_ID, front_id: front });
    for (const p of (d?.[env.CLAN_ID] || []))
      owned[p.province_id] = { name: p.province_name, arena: p.arena_name };
  }
  return owned;
}

// --- Discord -----------------------------------------------------------------

async function post(webhook, body) {
  await fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function buildEmbed(b, tags) {
  const r = ROLE[b.role] || ROLE.Bataille;
  const opp = b.opponents.map((o) => tags[o] || o).join(" / ") || "—";
  const ts = Math.floor(b.start / 1000);
  const embed = {
    title: `${r.emoji} ${b.arenaName}`,
    description: `**${b.provinceName}** — ${b.role} vs **${opp}**\n🗓️ <t:${ts}:F>\n⏳ <t:${ts}:R>`,
    color: r.color,
    footer: { text: "GR0UT • Carte Globale" },
  };
  if (b.image) embed.thumbnail = { url: b.image };
  return embed;
}

function slot(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, key: `${date}#${p.hour}:${p.minute}`, heure: `${p.hour}h${p.minute}` };
}

// --- Logique principale ------------------------------------------------------

async function runNotify(env) {
  const kv = env.STATE;
  const state = (await kv.get("state", "json")) || { notified: [], owned: null };
  const webhook = env.DISCORD_WEBHOOK_URL;
  let changed = false;
  const log = { provinces: "skip", battles: 0, posted: 0 };

  // 1) Provinces gagnées / perdues
  try {
    const current = await ownedProvinces(env);
    const prev = state.owned;
    state.owned = current;
    if (prev) {
      const P = new Set(Object.keys(prev)), C = new Set(Object.keys(current));
      for (const id of C) if (!P.has(id)) { await post(webhook, { content: `🏆 **GR0UT a pris ${current[id].name}** (${current[id].arena}) ! 🎉` }); changed = true; }
      for (const id of P) if (!C.has(id)) { await post(webhook, { content: `💔 GR0UT a perdu **${prev[id].name}** (${prev[id].arena}).` }); changed = true; }
      log.provinces = "ok";
    } else { changed = true; log.provinces = "baseline"; }
  } catch (e) { log.provinces = "front indispo"; }

  // 2) Batailles à venir (fenêtre LEAD_MIN..LEAD_MAX)
  let battles = [];
  try { battles = await collectBattles(env); } catch (e) { battles = []; }
  log.battles = battles.length;
  const now = Date.now();
  const due = battles.filter((b) => b.start >= now + LEAD_MIN * 60000 && b.start <= now + LEAD_MAX * 60000);

  if (due.length) {
    const notified = new Set(state.notified || []);
    const tags = await clanTags(env, due.flatMap((b) => b.opponents));
    const groups = {};
    for (const b of due) (groups[slot(b.start).key] = groups[slot(b.start).key] || []).push(b);
    for (const [key, group] of Object.entries(groups)) {
      if (notified.has(key)) continue;
      for (const b of group) b.image = await mapImage(b.arenaId);
      const embeds = group.sort((a, b) => (a.arenaName || "").localeCompare(b.arenaName || "")).map((b) => buildEmbed(b, tags));
      const heure = slot(group[0].start).heure;
      const ping = env.CW_ROLE_ID ? `<@&${env.CW_ROLE_ID}>` : "@here";
      const mentions = env.CW_ROLE_ID ? { roles: [env.CW_ROLE_ID] } : { parse: ["everyone"] };
      for (let i = 0; i < embeds.length; i += 10) {
        await post(webhook, {
          content: i === 0 ? `${ping} 🎯 **${group.length} bataille(s)** à **${heure}** — présentez-vous !` : "",
          embeds: embeds.slice(i, i + 10),
          allowed_mentions: i === 0 ? mentions : { parse: [] },
        });
      }
      notified.add(key); changed = true; log.posted++;
    }
    const cutoff = slot(now - 7 * 86400000).date;
    state.notified = [...notified].filter((k) => k.split("#")[0] >= cutoff);
  }

  if (changed) await kv.put("state", JSON.stringify(state));
  return log;
}

// --- Entrées -----------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      if (url.searchParams.get("key") !== env.RUN_SECRET)
        return new Response("Forbidden", { status: 403 });
      const log = await runNotify(env);
      return new Response(JSON.stringify(log), { headers: { "content-type": "application/json" } });
    }
    return new Response("GR0UT globalmap notifier OK", { status: 200 });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runNotify(env));
  },
};
