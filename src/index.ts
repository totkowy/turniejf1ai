interface Env {
  AI: Ai;
  F1_AI_SHARED_SECRET?: string;
}

const EDITORIAL_MODEL = "@cf/zai-org/glm-4.7-flash";
const MEDIA_MODEL = "@cf/zai-org/glm-4.7-flash";
const ANALYSIS_MODEL = "@cf/zai-org/glm-4.7-flash";
const SERVICE = "Turniej F1 2026 AI";
const VERSION = "3.0-media-analysis";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-F1-AI-Key",
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store",
      ...corsHeaders,
      ...extra,
    },
  });
}

function clean(value: unknown, max = 2000): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function stringArray(value: unknown, maxItems = 12, maxLen = 100): string[] {
  return Array.isArray(value)
    ? value.map((x) => clean(x, maxLen)).filter(Boolean).slice(0, maxItems)
    : [];
}

function numberArray(value: unknown, maxItems = 12): number[] {
  return Array.isArray(value)
    ? value
        .map((x) => Number(x))
        .filter((x) => Number.isFinite(x))
        .slice(0, maxItems)
    : [];
}

function numericTokens(value: string): Set<string> {
  const out = new Set<string>();
  for (const match of value.matchAll(/(?:^|[^\d])(\d+(?:[.,]\d+)?%?)/g)) {
    if (match[1]) out.add(match[1].replace(",", "."));
  }
  return out;
}

function outputUsesOnlySourceNumbers(source: string, output: string): boolean {
  const allowed = numericTokens(source);
  const used = numericTokens(output);
  for (const token of used) {
    if (!allowed.has(token)) return false;
  }
  return true;
}

function stripCodeFence(value: string): string {
  return value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseJsonObject(value: string): any {
  const cleaned = stripCodeFence(value);
  try { return JSON.parse(cleaned); } catch {}
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) return JSON.parse(cleaned.slice(first, last + 1));
  throw new Error("Brak poprawnego obiektu JSON w odpowiedzi AI.");
}

function extractModelText(result: any): string {
  if (typeof result?.response === "string") return result.response;
  const message = result?.choices?.[0]?.message?.content;
  if (typeof message === "string") return message;
  if (Array.isArray(message)) {
    return message.map((x: any) => (typeof x === "string" ? x : x?.text || "")).join("");
  }
  if (typeof result?.result?.response === "string") return result.result.response;
  return "";
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function authorized(request: Request, env: Env): boolean {
  const required = clean(env.F1_AI_SHARED_SECRET, 500);
  if (!required) return true;
  return request.headers.get("X-F1-AI-Key") === required;
}

function xml(value: unknown): string {
  return clean(value, 1000)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function initials(value: string): string {
  const parts = clean(value, 80).split(/\s+/).filter(Boolean).slice(0, 2);
  const out = parts.map((p) => p.charAt(0).toUpperCase()).join("");
  return out || "F1";
}

function colorFromSeed(seed: string, offset = 0): string {
  let acc = offset;
  for (const ch of seed) acc = (acc * 33 + ch.charCodeAt(0)) >>> 0;
  const hue = acc % 360;
  const sat = 72 - (acc % 11);
  const light = 48 + (acc % 8);
  return `hsl(${hue} ${sat}% ${light}%)`;
}

function slugTone(value: string): string {
  const v = clean(value, 30).toLowerCase();
  if (["alarm", "pressure", "tension"].includes(v)) return "alarm";
  if (["success", "surge", "breakthrough"].includes(v)) return "success";
  if (["duel", "battle", "fight"].includes(v)) return "duel";
  return "neutral";
}

function mediaAccent(seed: string, tone: string): {accent:string; secondary:string; bg1:string; bg2:string;} {
  if (tone === "alarm") {
    return {accent:"#ff3b30",secondary:"#ff9f0a",bg1:"#10070a",bg2:"#2d0b10"};
  }
  if (tone === "success") {
    return {accent:"#00c853",secondary:"#00b0ff",bg1:"#07100c",bg2:"#08222b"};
  }
  if (tone === "duel") {
    return {accent:"#ff2d55",secondary:"#4da3ff",bg1:"#090c14",bg2:"#151d2f"};
  }
  return {accent:colorFromSeed(seed, 17),secondary:colorFromSeed(seed, 99),bg1:"#080a11",bg2:"#1a1f2d"};
}

function svgDataUri(svg: string): string {
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function buildMediaSvg(input: {
  title: string;
  strapline: string;
  category: string;
  round: string;
  badge: string;
  focus: string[];
  focusTitle: string;
  tone: string;
  seed: string;
}) {
  const palette = mediaAccent(input.seed, slugTone(input.tone));
  const focus = input.focus.slice(0, 2);
  const left = focus[0] || input.focusTitle || input.category || "Turniej F1";
  const right = focus[1] || input.round || "Sezon 2026";
  const leftInit = initials(left);
  const rightInit = initials(right);
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900" role="img" aria-label="${xml(input.title)}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${palette.bg1}"/>
        <stop offset="100%" stop-color="${palette.bg2}"/>
      </linearGradient>
      <linearGradient id="accentA" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${palette.accent}" stop-opacity="0.96"/>
        <stop offset="100%" stop-color="${palette.secondary}" stop-opacity="0.92"/>
      </linearGradient>
      <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.12"/>
        <stop offset="100%" stop-color="#ffffff" stop-opacity="0.02"/>
      </linearGradient>
      <filter id="blur" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="40"/>
      </filter>
    </defs>
    <rect width="1600" height="900" fill="url(#bg)"/>
    <circle cx="1160" cy="240" r="220" fill="${palette.accent}" opacity="0.24" filter="url(#blur)"/>
    <circle cx="1320" cy="640" r="180" fill="${palette.secondary}" opacity="0.16" filter="url(#blur)"/>
    <path d="M0 760 C260 660, 380 640, 640 690 S1100 780,1600 640 L1600 900 L0 900 Z" fill="#ffffff" opacity="0.04"/>
    <rect x="56" y="52" rx="18" ry="18" width="226" height="56" fill="#ef233c"/>
    <text x="78" y="88" font-size="28" font-family="Arial, Helvetica, sans-serif" font-weight="800" fill="#ffffff">${xml(input.badge)}</text>
    <rect x="56" y="128" rx="28" ry="28" width="250" height="44" fill="#ffffff" fill-opacity="0.08" stroke="#ffffff" stroke-opacity="0.16"/>
    <text x="82" y="158" font-size="24" font-family="Arial, Helvetica, sans-serif" font-weight="700" fill="#ffffff">${xml(input.category.toUpperCase())}</text>
    <text x="56" y="248" font-size="86" font-family="Arial, Helvetica, sans-serif" font-weight="900" fill="#ffffff">${xml(input.title).slice(0, 90)}</text>
    <foreignObject x="58" y="282" width="780" height="190"><div xmlns="http://www.w3.org/1999/xhtml" style="font-family:Arial,Helvetica,sans-serif;font-size:31px;line-height:1.28;color:#dfe6ef;font-weight:600;">${xml(input.strapline).slice(0, 240)}</div></foreignObject>
    <rect x="58" y="760" rx="22" ry="22" width="530" height="88" fill="#0e121a" fill-opacity="0.78" stroke="#ffffff" stroke-opacity="0.12"/>
    <text x="88" y="796" font-size="22" font-family="Arial, Helvetica, sans-serif" font-weight="700" fill="#c9d1db">Runda</text>
    <text x="88" y="828" font-size="34" font-family="Arial, Helvetica, sans-serif" font-weight="900" fill="#ffffff">${xml(input.round || 'Aktualny etap sezonu')}</text>
    <rect x="650" y="116" rx="34" ry="34" width="422" height="680" fill="url(#glass)" stroke="#ffffff" stroke-opacity="0.11"/>
    <rect x="710" y="194" rx="34" ry="34" width="250" height="470" fill="url(#accentA)" opacity="0.95"/>
    <circle cx="835" cy="255" r="94" fill="#ffffff" fill-opacity="0.1"/>
    <text x="835" y="284" text-anchor="middle" font-size="108" font-family="Arial, Helvetica, sans-serif" font-weight="900" fill="#ffffff">${xml(leftInit)}</text>
    <text x="835" y="555" text-anchor="middle" font-size="56" font-family="Arial, Helvetica, sans-serif" font-weight="900" fill="#ffffff">1</text>
    <text x="835" y="612" text-anchor="middle" font-size="36" font-family="Arial, Helvetica, sans-serif" font-weight="800" fill="#ffffff">${xml(left.toUpperCase()).slice(0, 26)}</text>
    <rect x="1010" y="230" rx="34" ry="34" width="250" height="434" fill="#0f68c2" opacity="0.9"/>
    <circle cx="1135" cy="285" r="92" fill="#ffffff" fill-opacity="0.1"/>
    <text x="1135" y="314" text-anchor="middle" font-size="100" font-family="Arial, Helvetica, sans-serif" font-weight="900" fill="#ffffff">${xml(rightInit)}</text>
    <text x="1135" y="560" text-anchor="middle" font-size="52" font-family="Arial, Helvetica, sans-serif" font-weight="900" fill="#ffffff">2</text>
    <text x="1135" y="612" text-anchor="middle" font-size="34" font-family="Arial, Helvetica, sans-serif" font-weight="800" fill="#ffffff">${xml(right.toUpperCase()).slice(0, 26)}</text>
    <rect x="1100" y="86" rx="18" ry="18" width="366" height="76" fill="#0d1117" fill-opacity="0.78" stroke="#ffffff" stroke-opacity="0.14"/>
    <text x="1128" y="118" font-size="22" font-family="Arial, Helvetica, sans-serif" font-weight="800" fill="#c7ced7">AI VISUAL</text>
    <text x="1128" y="146" font-size="22" font-family="Arial, Helvetica, sans-serif" font-weight="700" fill="#ffffff">Wygenerowane przez AI • ${xml(SERVICE)}</text>
    <text x="1110" y="840" font-size="20" font-family="Arial, Helvetica, sans-serif" font-weight="700" fill="#b4bdc7">Model: ${xml(MEDIA_MODEL)} • Fakty: News Engine + Truth Guard</text>
  </svg>`;
  return svgDataUri(svg);
}

async function withCache(request: Request, keySuffix: string, producer: () => Promise<any>) {
  const cacheUrl = `${new URL(request.url).origin}/__f1_ai_cache/${keySuffix}`;
  const cacheKey = new Request(cacheUrl, { method: "GET" });
  const cache = (caches as any).default as Cache;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const text = await cached.text();
    return { payloadText: text, hit: true, cache, cacheKey };
  }
  const payload = await producer();
  const payloadText = JSON.stringify(payload);
  try {
    await cache.put(
      cacheKey,
      new Response(payloadText, {
        headers: {
          "content-type": "application/json; charset=UTF-8",
          "cache-control": "public, max-age=2592000",
        },
      }),
    );
  } catch (_) {}
  return { payloadText, hit: false, cache, cacheKey };
}

async function editorial(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env)) return json({ ok: false, error: "Brak autoryzacji F1 AI." }, 401);
  const raw = await request.text();
  if (!raw || raw.length > 30000) return json({ ok: false, error: "Nieprawidłowy rozmiar danych wejściowych." }, 400);

  let body: any;
  try { body = JSON.parse(raw); } catch { return json({ ok: false, error: "Body musi być JSON-em." }, 400); }

  const event = body?.event || {};
  const id = clean(event.id, 220);
  const title = clean(event.title, 500);
  const text = clean(event.text, 1200);
  const round = clean(event.round, 180);
  const category = clean(event.category, 80);
  const truthEvidence = clean(event.truthEvidence, 1800);
  const season = clean(body?.season, 40);
  const people = stringArray(event.people, 8, 80);
  const teams = stringArray(event.teams, 8, 80);
  const tags = stringArray(event.tags, 8, 80);
  if (!id || !title || !text) return json({ ok: false, error: "Brakuje ID, tytułu albo treści newsa." }, 400);

  const canonical = JSON.stringify({ id, season, title, text, round, category, truthEvidence, people, teams, tags });
  const sourceHash = await sha256Hex(canonical);
  const cached = await withCache(request, `editorial/${sourceHash}`, async () => {
    const system = [
      "Jesteś redaktorem oficjalnego newsroomu amatorskiej ligi wyścigowej Turniej F1 2026.",
      "Twoim zadaniem jest WYŁĄCZNIE redakcja tekstu dostarczonego przez News Engine.",
      "Nie jesteś źródłem faktów i nie wolno Ci dodawać żadnych nowych faktów, nazwisk, zespołów, torów, liczb, przyczyn, przewidywań ani cytatów.",
      "Wszystkie fakty pochodzą z News Engine i Truth Guard 2.1. Jeśli nie da się czegoś wywnioskować wprost z wejścia, pomiń to.",
      "Zachowuj sens, liczby, osoby, zespoły, rundę i kierunek relacji dokładnie jak w wejściu.",
      "Pisz naturalnie po polsku, sportowo i profesjonalnie, ale bez clickbaitu i bez przesady.",
      "Zwróć WYŁĄCZNIE poprawny JSON bez markdownu w formacie: {\"headline\":\"...\",\"lead\":\"...\",\"paragraphs\":[\"...\",\"...\"]}.",
      "headline: maks. 95 znaków; lead: maks. 280 znaków; paragraphs: 1-2 akapity, każdy maks. 520 znaków.",
    ].join("\n");

    const user = [
      `SEZON: ${season || "brak"}`,
      `ID: ${id}`,
      `RUNDA: ${round || "brak"}`,
      `KATEGORIA: ${category || "news"}`,
      `OSOBY DOZWOLONE: ${people.join(", ") || "brak"}`,
      `ZESPOŁY DOZWOLONE: ${teams.join(", ") || "brak"}`,
      `TAGI: ${tags.join(", ") || "brak"}`,
      `ORYGINALNY TYTUŁ: ${title}`,
      `ORYGINALNY LEAD: ${text}`,
      `DOWODY TRUTH GUARD: ${truthEvidence || "brak dodatkowych dowodów"}`,
      "Przeredaguj ten materiał. Nie dopisuj niczego spoza powyższych danych.",
    ].join("\n");

    const result: any = await env.AI.run(EDITORIAL_MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.25,
      max_completion_tokens: 650,
    } as any);

    const modelText = extractModelText(result);
    const parsed = parseJsonObject(modelText);
    const headline = clean(parsed?.headline, 95);
    const lead = clean(parsed?.lead, 280);
    const paragraphs = stringArray(parsed?.paragraphs, 2, 520);
    if (!headline || !lead || !paragraphs.length) throw new Error("AI zwróciło niepełną redakcję.");
    const sourceForNumbers = [season, round, title, text, truthEvidence, people.join(" "), teams.join(" "), tags.join(" ")].join(" ");
    const outputForNumbers = [headline, lead, ...paragraphs].join(" ");
    if (!outputUsesOnlySourceNumbers(sourceForNumbers, outputForNumbers)) throw new Error("AI próbowało dodać liczbę, której nie było w danych źródłowych.");
    if (/https?:\/\//i.test(outputForNumbers)) throw new Error("AI zwróciło niedozwolony adres URL.");

    return {
      ok: true,
      service: SERVICE,
      version: VERSION,
      model: EDITORIAL_MODEL,
      sourceHash,
      editorial: {
        headline,
        lead,
        paragraphs,
        mode: "AI_REDAKCJA",
        factsVerifiedBy: "Truth Guard 2.1",
        source: "News Engine",
      },
    };
  });

  return new Response(cached.payloadText, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store",
      "X-F1-AI-Cache": cached.hit ? "HIT" : "MISS",
      ...corsHeaders,
    },
  });
}

async function media(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env)) return json({ ok: false, error: "Brak autoryzacji F1 AI." }, 401);
  const raw = await request.text();
  if (!raw || raw.length > 30000) return json({ ok: false, error: "Nieprawidłowy rozmiar danych wejściowych." }, 400);
  let body: any;
  try { body = JSON.parse(raw); } catch { return json({ ok: false, error: "Body musi być JSON-em." }, 400); }

  const event = body?.event || {};
  const id = clean(event.id, 220);
  const title = clean(event.title, 500);
  const text = clean(event.text, 1000);
  const round = clean(event.round, 180);
  const category = clean(event.category, 80);
  const truthEvidence = clean(event.truthEvidence, 1400);
  const season = clean(body?.season, 40);
  const people = stringArray(event.people, 6, 80);
  const teams = stringArray(event.teams, 6, 80);
  const tags = stringArray(event.tags, 8, 60);
  if (!id || !title || !text) return json({ ok: false, error: "Brakuje ID, tytułu albo treści newsa." }, 400);

  const canonical = JSON.stringify({ id, season, title, text, round, category, truthEvidence, people, teams, tags });
  const sourceHash = await sha256Hex(canonical);
  const cached = await withCache(request, `media/${sourceHash}`, async () => {
    const system = [
      "Tworzysz krótką koncepcję grafiki newsowej dla ligi Turniej F1 2026.",
      "Nie dodawaj żadnych nowych faktów ani liczb.",
      "Masz przygotować WYŁĄCZNIE zwięzły JSON sterujący abstrakcyjnym key visualem.",
      "Grafika będzie finalnie złożona jako SVG z oznaczeniem AI VISUAL.",
      "Zwróć JSON: {\"strapline\":\"...\",\"focusTitle\":\"...\",\"focus\":[\"...\",\"...\"],\"tone\":\"duel|alarm|success|neutral\"}.",
      "strapline max 160 znaków, focusTitle max 40 znaków, focus do 2 krótkich haseł.",
    ].join("\n");
    const user = [
      `SEZON: ${season || 'brak'}`,
      `TYTUŁ: ${title}`,
      `LEAD: ${text}`,
      `RUNDA: ${round || 'brak'}`,
      `KATEGORIA: ${category || 'news'}`,
      `OSOBY: ${people.join(', ') || 'brak'}`,
      `ZESPOŁY: ${teams.join(', ') || 'brak'}`,
      `TAGI: ${tags.join(', ') || 'brak'}`,
      `DOWODY: ${truthEvidence || 'brak'}`,
      'Zaproponuj wyłącznie krótki art direction do wizualu newsowego bez dopisywania faktów.',
    ].join("\n");

    const result: any = await env.AI.run(MEDIA_MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.35,
      max_completion_tokens: 280,
    } as any);
    const parsed = parseJsonObject(extractModelText(result));
    const strapline = clean(parsed?.strapline || text, 160) || title;
    const focusTitle = clean(parsed?.focusTitle || category || 'Turniej F1', 40);
    const focus = stringArray(parsed?.focus, 2, 34);
    const tone = clean(parsed?.tone || 'neutral', 20).toLowerCase();
    const sourceForNumbers = [season, title, text, round, category, truthEvidence, people.join(" "), teams.join(" "), tags.join(" ")].join(" ");
    const outputForNumbers = [strapline, focusTitle, ...focus].join(" ");
    if (!outputUsesOnlySourceNumbers(sourceForNumbers, outputForNumbers)) throw new Error("AI visual próbowało dodać nową liczbę.");
    const imageDataUri = buildMediaSvg({
      title,
      strapline,
      category,
      round,
      badge: 'AI VISUAL',
      focus: focus.length ? focus : [...people.slice(0,2), ...teams.slice(0,2)].slice(0,2),
      focusTitle,
      tone,
      seed: sourceHash,
    });
    return {
      ok: true,
      service: SERVICE,
      version: VERSION,
      model: MEDIA_MODEL,
      sourceHash,
      media: {
        kind: 'svg',
        imageDataUri,
        alt: `AI wygenerowany wizual do newsa: ${title}`,
        strapline,
        focusTitle,
        focus,
        tone,
        label: 'AI VISUAL • wygenerowane przez AI',
        factsVerifiedBy: 'Truth Guard 2.1',
        source: 'News Engine',
      },
    };
  });
  return new Response(cached.payloadText, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store",
      "X-F1-AI-Cache": cached.hit ? "HIT" : "MISS",
      ...corsHeaders,
    },
  });
}

async function analysis(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env)) return json({ ok: false, error: "Brak autoryzacji F1 AI." }, 401);
  const raw = await request.text();
  if (!raw || raw.length > 28000) return json({ ok: false, error: "Nieprawidłowy rozmiar danych wejściowych." }, 400);
  let body: any;
  try { body = JSON.parse(raw); } catch { return json({ ok: false, error: "Body musi być JSON-em." }, 400); }

  const snapshot = body?.snapshot || {};
  const season = clean(body?.season, 40);
  const played = Number(snapshot?.played ?? 0);
  const remaining = Number(snapshot?.remaining ?? 0);
  const leader = snapshot?.leader || {};
  const p2 = snapshot?.p2 || {};
  const titleGap = Number(snapshot?.titleGap ?? 0);
  const contenders = numberArray(snapshot?.contenders, 10);
  const closestBattle = snapshot?.closestBattle || {};
  const momentumLeader = snapshot?.momentumLeader || {};
  const constructorLeader = snapshot?.constructorLeader || {};
  const constructorBattle = snapshot?.constructorBattle || {};
  const topDrivers = Array.isArray(snapshot?.topDrivers) ? snapshot.topDrivers : [];
  const sourceObject = {
    season, played, remaining,
    leader: { name: clean(leader.name, 60), points: Number(leader.points ?? 0), wins: Number(leader.wins ?? 0), podiums: Number(leader.podiums ?? 0) },
    p2: { name: clean(p2.name, 60), points: Number(p2.points ?? 0) },
    titleGap,
    contenders: contenders.map((v) => Number(v)),
    closestBattle: { a: clean(closestBattle.a, 60), b: clean(closestBattle.b, 60), gap: Number(closestBattle.gap ?? 0) },
    momentumLeader: { name: clean(momentumLeader.name, 60), delta: Number(momentumLeader.delta ?? 0) },
    constructorLeader: { team: clean(constructorLeader.team, 60), points: Number(constructorLeader.points ?? 0) },
    constructorBattle: { a: clean(constructorBattle.a, 60), b: clean(constructorBattle.b, 60), gap: Number(constructorBattle.gap ?? 0) },
    topDrivers: topDrivers.slice(0, 5).map((x: any) => ({ name: clean(x?.name, 60), points: Number(x?.points ?? 0), gap: Number(x?.gap ?? 0) })),
  };
  if (!sourceObject.leader.name) return json({ ok: false, error: "Brak danych lidera do analizy AI." }, 400);

  const sourceHash = await sha256Hex(JSON.stringify(sourceObject));
  const cached = await withCache(request, `analysis/${sourceHash}`, async () => {
    const system = [
      'Tworzysz komentarz analityczny do ligi Turniej F1 2026.',
      'Nie dodawaj żadnych nowych faktów, nazw, liczb ani przewidywań nieobecnych w danych wejściowych.',
      'Analiza ma być krótka, konkretna, sportowa i profesjonalna.',
      'Zwróć WYŁĄCZNIE JSON bez markdownu.',
      'Format: {"headline":"...","summary":"...","bullets":["...","...","..."],"titleFight":"...","momentum":"...","constructors":"..."}.',
      'headline max 90, summary max 260, każde bullet/titleFight/momentum/constructors max 180 znaków.',
    ].join('\n');
    const user = [
      `SEZON: ${season}`,
      `ROZEGRANE GP: ${played}`,
      `POZOSTAŁE GP: ${remaining}`,
      `LIDER: ${sourceObject.leader.name} / ${sourceObject.leader.points} pkt / ${sourceObject.leader.wins} wygranych / ${sourceObject.leader.podiums} podiów`,
      `P2: ${sourceObject.p2.name || 'brak'} / ${sourceObject.p2.points || 0} pkt`,
      `PRZEWAGA LIDERA NAD P2: ${titleGap} pkt`,
      `NAJCIAŚNIEJSZA WALKA: ${sourceObject.closestBattle.a || 'brak'} vs ${sourceObject.closestBattle.b || 'brak'} / ${sourceObject.closestBattle.gap} pkt`,
      `MOMENTUM LEADER: ${sourceObject.momentumLeader.name || 'brak'} / ${sourceObject.momentumLeader.delta} pkt`,
      `LIDER KONSTRUKTORÓW: ${sourceObject.constructorLeader.team || 'brak'} / ${sourceObject.constructorLeader.points} pkt`,
      `NAJBLIŻSZA WALKA KONSTRUKTORÓW: ${sourceObject.constructorBattle.a || 'brak'} vs ${sourceObject.constructorBattle.b || 'brak'} / ${sourceObject.constructorBattle.gap} pkt`,
      `TOP 5: ${sourceObject.topDrivers.map((x) => `${x.name} ${x.points} pkt strata ${x.gap}`).join(' | ')}`,
      'Napisz zwięzły komentarz analityczny oparty tylko na tych danych.',
    ].join('\n');

    const result: any = await env.AI.run(ANALYSIS_MODEL, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.25,
      max_completion_tokens: 420,
    } as any);
    const parsed = parseJsonObject(extractModelText(result));
    const headline = clean(parsed?.headline, 90);
    const summary = clean(parsed?.summary, 260);
    const bullets = stringArray(parsed?.bullets, 3, 180);
    const titleFight = clean(parsed?.titleFight, 180);
    const momentum = clean(parsed?.momentum, 180);
    const constructors = clean(parsed?.constructors, 180);
    if (!headline || !summary || bullets.length < 2 || !titleFight || !momentum || !constructors) {
      throw new Error('AI zwróciło niepełną analizę.');
    }
    const sourceForNumbers = JSON.stringify(sourceObject);
    const outputForNumbers = [headline, summary, ...bullets, titleFight, momentum, constructors].join(' ');
    if (!outputUsesOnlySourceNumbers(sourceForNumbers, outputForNumbers)) throw new Error('AI analiza próbowała dodać nową liczbę.');
    return {
      ok: true,
      service: SERVICE,
      version: VERSION,
      model: ANALYSIS_MODEL,
      sourceHash,
      analysis: {
        headline,
        summary,
        bullets,
        titleFight,
        momentum,
        constructors,
        label: 'AI ANALIZA • wsparta przez AI',
        factsVerifiedBy: 'Dane ligi + News Engine + Truth Guard 2.1',
      },
    };
  });
  return new Response(cached.payloadText, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store",
      "X-F1-AI-Cache": cached.hit ? "HIT" : "MISS",
      ...corsHeaders,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') {
      return json({
        ok: true,
        service: SERVICE,
        version: VERSION,
        editorialModel: EDITORIAL_MODEL,
        mediaModel: MEDIA_MODEL,
        analysisModel: ANALYSIS_MODEL,
        aiBinding: Boolean(env.AI),
        endpoints: ['/api/test','/api/editorial','/api/media','/api/analysis'],
      });
    }
    if (request.method === 'POST' && url.pathname === '/api/test') {
      try {
        const result = await env.AI.run(EDITORIAL_MODEL, {
          messages: [
            { role: 'system', content: 'Odpowiadaj krótko i po polsku.' },
            { role: 'user', content: 'Napisz jedno krótkie zdanie potwierdzające, że Turniej F1 AI działa.' },
          ],
          temperature: 0.2,
          max_completion_tokens: 100,
        } as any);
        return json({ ok: true, model: EDITORIAL_MODEL, result });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }
    try {
      if (request.method === 'POST' && url.pathname === '/api/editorial') return await editorial(request, env);
      if (request.method === 'POST' && url.pathname === '/api/media') return await media(request, env);
      if (request.method === 'POST' && url.pathname === '/api/analysis') return await analysis(request, env);
      return json({ ok: false, error: 'Nieznany endpoint.' }, 404);
} catch (error) {
  return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
}
  },
} satisfies ExportedHandler<Env>;
