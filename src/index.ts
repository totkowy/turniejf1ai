interface Env {
  AI: Ai;
  F1_AI_SHARED_SECRET?: string;
}

const EDITORIAL_MODEL = "@cf/zai-org/glm-4.7-flash";
const MEDIA_DIRECTION_MODEL = "@cf/zai-org/glm-4.7-flash";
const MEDIA_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
const ANALYSIS_MODEL = "@cf/zai-org/glm-4.7-flash";
const SERVICE = "Turniej F1 2026 AI";
const VERSION = "3.3-real-ai-images";

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


function parseToolArguments(value: unknown): any | null {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function extractStructuredToolArgs(result: any, toolName: string): any | null {
  const directCalls = Array.isArray(result?.tool_calls) ? result.tool_calls : [];
  const messageCalls = Array.isArray(result?.choices?.[0]?.message?.tool_calls)
    ? result.choices[0].message.tool_calls
    : [];
  const nestedCalls = Array.isArray(result?.result?.tool_calls) ? result.result.tool_calls : [];
  const calls = [...directCalls, ...messageCalls, ...nestedCalls];
  for (const call of calls) {
    const name = clean(call?.name || call?.function?.name, 120);
    if (toolName && name && name !== toolName) continue;
    const args = parseToolArguments(call?.arguments ?? call?.function?.arguments);
    if (args) return args;
  }
  return null;
}

async function runStructured(
  env: Env,
  model: string,
  messages: Array<{ role: string; content: string }>,
  toolName: string,
  description: string,
  parameters: any,
  maxCompletionTokens: number,
): Promise<any> {
  const result: any = await env.AI.run(model as any, {
    messages,
    tools: [
      {
        type: "function",
        function: {
          name: toolName,
          description,
          parameters,
        },
      },
    ],
    tool_choice: {
      type: "function",
      function: { name: toolName },
    },
    reasoning_effort: null,
    chat_template_kwargs: {
      enable_thinking: false,
      clear_thinking: true,
    },
    temperature: 0.15,
    max_completion_tokens: Math.max(maxCompletionTokens, 1200),
  } as any);

  const toolArgs = extractStructuredToolArgs(result, toolName);
  if (toolArgs) return toolArgs;

  // Fallback: jeśli provider zwróci zwykły tekst zamiast tool calla,
  // próbujemy jeszcze odczytać JSON z content/response.
  const text = extractModelText(result);
  if (text) {
    try { return parseJsonObject(text); } catch {}
  }

  const finishReason = clean(result?.choices?.[0]?.finish_reason || result?.finish_reason || "brak", 80);
  const responseType = clean(result?.object || result?.type || typeof result, 80);
  throw new Error(`AI nie zwróciło danych strukturalnych. finish_reason=${finishReason}, response=${responseType}`);
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

function slugTone(value: string): string {
  const v = clean(value, 30).toLowerCase();
  if (["alarm", "pressure", "tension"].includes(v)) return "alarm";
  if (["success", "surge", "breakthrough"].includes(v)) return "success";
  if (["duel", "battle", "fight"].includes(v)) return "duel";
  return "neutral";
}


function base64UrlEncodeUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecodeUtf8(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function base64ToBytes(value: string): Uint8Array {
  const cleanBase64 = value.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");
  const binary = atob(cleanBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function imageMimeType(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(8,12)) === "WEBP") return "image/webp";
  return "image/jpeg";
}

function deterministicSeed(hash: string): number {
  const parsed = Number.parseInt(hash.slice(0, 8), 16);
  return Number.isFinite(parsed) ? (parsed & 0x7fffffff) : 2026;
}

function teamLiveryDescription(team: string): string {
  const key = clean(team, 80).toUpperCase().replace(/\s+/g, " ");
  if (!key) return "neutral dark graphite with subtle red accents";
  if (key.includes("MCLAREN")) return "papaya orange and black";
  if (key.includes("FERRARI")) return "scarlet racing red with restrained black accents";
  if (key.includes("RED BULL") || key.includes("REDBULL")) return "deep navy blue with vivid red and yellow accents";
  if (key.includes("MERCEDES")) return "metallic silver and black with turquoise accents";
  if (key.includes("ASTON")) return "British racing green with lime accents";
  if (key.includes("ALPINE")) return "deep blue with pink accents";
  if (key.includes("WILLIAMS")) return "bright royal blue with white accents";
  if (key.includes("HAAS")) return "white, black and red";
  if (key.includes("RACING BULL") || key === "RB") return "white and dark navy with blue accents";
  if (key.includes("SAUBER")) return "black with vivid electric green accents";
  if (key.includes("AUDI")) return "black, graphite and deep red";
  if (key.includes("CADILLAC")) return "black, white and metallic silver";
  return "distinctive professional racing colors matching the supplied team identity";
}

function buildNewsPhotoPrompt(input: {
  title: string;
  text: string;
  round: string;
  category: string;
  people: string[];
  teams: string[];
  tone: string;
}) {
  const teamA = input.teams[0] ? teamLiveryDescription(input.teams[0]) : "";
  const teamB = input.teams[1] ? teamLiveryDescription(input.teams[1]) : "";
  const teamLine = teamA && teamB
    ? `Show two rival fictional single-seat race cars: the first in ${teamA}, the second in ${teamB}.`
    : teamA
      ? `Show one leading fictional single-seat race car in ${teamA}.`
      : "Use believable modern motorsport liveries in dark graphite, red and metallic tones.";
  const mood = slugTone(input.tone);
  const sceneHint = mood === "duel"
    ? "Capture a close wheel-to-wheel battle or overtaking moment."
    : mood === "alarm"
      ? "Capture a tense high-pressure racing moment with dramatic braking or a close chase."
      : mood === "success"
        ? "Capture a triumphant but realistic racing moment, such as crossing the line or exiting a corner strongly."
        : "Capture a realistic dynamic race-weekend moment on circuit.";
  const narrative = clean(`${input.title}. ${input.text}`, 420);
  return clean([
    "Photorealistic editorial motorsport photograph for a fictional amateur open-wheel championship in 2026.",
    "Modern single-seat race cars, realistic carbon fibre, tyres, track surface, safety barriers and grandstands.",
    teamLine,
    sceneHint,
    narrative ? `Story context: ${narrative}` : "",
    input.round ? `Race-weekend context: ${clean(input.round, 100)}.` : "",
    "Use a cinematic sports-photography camera angle, realistic motion blur, natural lighting and believable proportions.",
    "Drivers must remain helmeted and non-identifiable; do not invent recognizable faces.",
    "ABSOLUTELY NO readable text, letters, numbers, logos, sponsor marks, flags with words, captions, UI, badges or watermarks inside the image.",
    "The image itself must contain only the scene; website text will be rendered separately."
  ].filter(Boolean).join(" "), 1500);
}

const TRACK_SCENES: Record<string, string> = {
  "melbourne": "Albert Park style temporary parkland street circuit in Melbourne, green park, lake and city skyline",
  "shanghai": "Shanghai International Circuit style modern permanent racing circuit with sweeping grandstands and futuristic architecture",
  "suzuka": "Suzuka style Japanese figure-eight racing circuit surrounded by green landscape and packed grandstands",
  "sakhir": "Bahrain International Circuit style desert racing venue at Sakhir with floodlights and sandy surroundings",
  "jeddah": "Jeddah Corniche style ultra-fast night street circuit beside the Red Sea with city lights",
  "miami": "Miami Gardens style modern temporary circuit around a stadium with palm trees and bright Florida atmosphere",
  "montreal": "Circuit Gilles Villeneuve style island racing circuit in Montreal surrounded by trees and water",
  "monaco": "Monaco street circuit style racing through Monte Carlo harbour, yachts, dense city buildings and barriers",
  "barcelona": "Barcelona-Catalunya style permanent circuit on rolling dry terrain outside Barcelona",
  "spielberg": "Red Bull Ring style compact Austrian circuit in green Styrian hills and mountains",
  "silverstone": "Silverstone style fast British permanent circuit with broad run-off areas, large grandstands and overcast dramatic sky",
  "spa": "Spa-Francorchamps style long Belgian circuit through forested Ardennes hills with dramatic elevation changes",
  "hungaroring": "Hungaroring style compact technical circuit in rolling Hungarian countryside near Budapest",
  "zandvoort": "Zandvoort style Dutch coastal circuit among sand dunes near the North Sea",
  "monza": "Monza style historic ultra-fast Italian circuit running through dense parkland and old trees",
  "madrid": "Madring style modern Spanish semi-urban circuit in Madrid with contemporary city infrastructure",
  "baku": "Baku street circuit style racing through historic stone city walls and modern skyline on the Caspian coast",
  "singapore": "Marina Bay style night street circuit in Singapore with skyscrapers, floodlights and illuminated waterfront",
  "austin": "Circuit of the Americas style Texas racing circuit with dramatic elevation and a tall observation tower",
  "mexico-city": "Autodromo Hermanos Rodriguez style high-altitude circuit in Mexico City with stadium section and packed grandstands",
  "interlagos": "Interlagos style compact Brazilian circuit on rolling terrain in Sao Paulo with dense urban skyline",
  "las-vegas": "Las Vegas Strip style night street circuit with neon-lit resort skyline and bright city reflections",
  "lusail": "Lusail style floodlit desert racing circuit in Qatar at night with modern grandstands",
  "yas-marina": "Yas Marina style Abu Dhabi circuit at dusk with marina, modern architecture and illuminated hotel",
  "imola": "Imola style classic Italian racing circuit through green parkland with old-school kerbs and elevation"
};

function buildTrackPhotoPrompt(key: string): string | null {
  const scene = TRACK_SCENES[key];
  if (!scene) return null;
  return clean([
    `Photorealistic high aerial drone-style motorsport photograph of a ${scene}.`,
    "The racing circuit itself must be clearly visible and be the main subject of the frame.",
    "Show realistic asphalt, kerbs, barriers, run-off, pit buildings and grandstands appropriate to the location.",
    "Wide cinematic composition, realistic daylight or night lighting appropriate to the venue, highly detailed but believable.",
    "No close-up drivers. No readable text, labels, numbers, logos, sponsor marks, UI or watermarks.",
    "This is an AI visualization for a race calendar, not a technical or official circuit map."
  ].join(" "), 1200);
}

async function fluxImageBytes(env: Env, prompt: string, seedHash: string): Promise<Uint8Array> {
  const form = new FormData();
  form.append("prompt", prompt);
  form.append("width", "1024");
  form.append("height", "512");
  form.append("seed", String(deterministicSeed(seedHash)));
  const formResponse = new Response(form);
  const formStream = formResponse.body;
  const formContentType = formResponse.headers.get("content-type");
  if (!formStream || !formContentType) throw new Error("Nie udało się przygotować danych obrazu dla Workers AI.");
  const result: any = await env.AI.run(MEDIA_MODEL as any, {
    multipart: {
      body: formStream,
      contentType: formContentType,
    },
  } as any);
  const image = typeof result?.image === "string" ? result.image : "";
  if (!image) throw new Error("Model obrazu nie zwrócił danych JPEG.");
  return base64ToBytes(image);
}

async function serveGeneratedImage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const cache = (caches as any).default as Cache;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let prompt = "";
  let seedHash = "";
  if (url.pathname.startsWith("/media/news/")) {
    const match = url.pathname.match(/^\/media\/news\/([a-f0-9]{64})\.jpg$/);
    if (!match) return new Response("Not found", { status: 404 });
    const encoded = url.searchParams.get("p") || "";
    if (!encoded || encoded.length > 6000) return new Response("Invalid image prompt", { status: 400 });
    try { prompt = base64UrlDecodeUtf8(encoded); } catch { return new Response("Invalid image prompt", { status: 400 }); }
    const actualHash = await sha256Hex(prompt);
    if (actualHash !== match[1]) return new Response("Invalid image signature", { status: 400 });
    seedHash = actualHash;
  } else {
    const match = url.pathname.match(/^\/media\/track-v1\/([a-z0-9-]{2,40})\.jpg$/);
    if (!match) return new Response("Not found", { status: 404 });
    prompt = buildTrackPhotoPrompt(match[1]) || "";
    if (!prompt) return new Response("Unknown track", { status: 404 });
    seedHash = await sha256Hex(`track-v1:${match[1]}:${prompt}`);
  }

  const bytes = await fluxImageBytes(env, prompt, seedHash);
  const response = new Response(bytes, {
    status: 200,
    headers: {
      "content-type": imageMimeType(bytes),
      "cache-control": "public, max-age=31536000, immutable",
      "Access-Control-Allow-Origin": "*",
      "X-F1-AI-Image-Model": MEDIA_MODEL,
      "X-F1-AI-Generated": "1",
    },
  });
  try { await cache.put(cacheKey, response.clone()); } catch (_) {}
  return response;
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

    const parsed = await runStructured(
      env,
      EDITORIAL_MODEL,
      [
        { role: "system", content: system },
        { role: "user", content: user + "\nZakończ odpowiedź wywołaniem narzędzia submitEditorial." },
      ],
      "submitEditorial",
      "Zwróć gotową, bezpieczną redakcję newsa opartą wyłącznie na dostarczonych faktach.",
      {
        type: "object",
        properties: {
          headline: { type: "string" },
          lead: { type: "string" },
          paragraphs: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 },
        },
        required: ["headline", "lead", "paragraphs"],
      },
      900,
    );
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
  const cached = await withCache(request, `media-v33/${sourceHash}`, async () => {
    const system = [
      "Tworzysz krótką koncepcję grafiki newsowej dla ligi Turniej F1 2026.",
      "Nie dodawaj żadnych nowych faktów ani liczb.",
      "Masz przygotować WYŁĄCZNIE zwięzły JSON opisujący kierunek realistycznej fotografii motorsportowej.",
      "Finalny obraz zostanie wygenerowany osobnym modelem text-to-image i nie może zawierać tekstu.",
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

    const parsed = await runStructured(
      env,
      MEDIA_DIRECTION_MODEL,
      [
        { role: "system", content: system },
        { role: "user", content: user + "\nZakończ odpowiedź wywołaniem narzędzia submitMediaDirection." },
      ],
      "submitMediaDirection",
      "Zwróć krótki art direction do wizualu newsowego bez dodawania nowych faktów.",
      {
        type: "object",
        properties: {
          strapline: { type: "string" },
          focusTitle: { type: "string" },
          focus: { type: "array", items: { type: "string" }, maxItems: 2 },
          tone: { type: "string", enum: ["duel", "alarm", "success", "neutral"] },
        },
        required: ["strapline", "focusTitle", "focus", "tone"],
      },
      650,
    );
    const strapline = clean(parsed?.strapline || text, 160) || title;
    const focusTitle = clean(parsed?.focusTitle || category || 'Turniej F1', 40);
    const focus = stringArray(parsed?.focus, 2, 34);
    const tone = clean(parsed?.tone || 'neutral', 20).toLowerCase();
    const sourceForNumbers = [season, title, text, round, category, truthEvidence, people.join(" "), teams.join(" "), tags.join(" ")].join(" ");
    const outputForNumbers = [strapline, focusTitle, ...focus].join(" ");
    if (!outputUsesOnlySourceNumbers(sourceForNumbers, outputForNumbers)) throw new Error("AI visual próbowało dodać nową liczbę.");
    const imagePrompt = buildNewsPhotoPrompt({ title, text, round, category, people, teams, tone });
    const imageHash = await sha256Hex(imagePrompt);
    const origin = new URL(request.url).origin;
    const imageDataUri = `${origin}/media/news/${imageHash}.jpg?p=${encodeURIComponent(base64UrlEncodeUtf8(imagePrompt))}`;
    return {
      ok: true,
      service: SERVICE,
      version: VERSION,
      model: MEDIA_MODEL,
      sourceHash,
      media: {
        kind: 'photo',
        imageDataUri,
        alt: `Fotorealistyczny wizual AI do newsa: ${title}`,
        strapline,
        focusTitle,
        focus,
        tone,
        label: 'AI FOTO • wygenerowane przez AI',
        factsVerifiedBy: 'Truth Guard 2.1',
        source: 'News Engine',
        directionModel: MEDIA_DIRECTION_MODEL,
        imageModel: MEDIA_MODEL,
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

    const parsed = await runStructured(
      env,
      ANALYSIS_MODEL,
      [
        { role: 'system', content: system },
        { role: 'user', content: user + '\nZakończ odpowiedź wywołaniem narzędzia submitAnalysis.' },
      ],
      'submitAnalysis',
      'Zwróć komentarz analityczny oparty wyłącznie na dostarczonych danych sezonu.',
      {
        type: 'object',
        properties: {
          headline: { type: 'string' },
          summary: { type: 'string' },
          bullets: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 3 },
          titleFight: { type: 'string' },
          momentum: { type: 'string' },
          constructors: { type: 'string' },
        },
        required: ['headline', 'summary', 'bullets', 'titleFight', 'momentum', 'constructors'],
      },
      850,
    );
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
        mediaDirectionModel: MEDIA_DIRECTION_MODEL,
        mediaModel: MEDIA_MODEL,
        analysisModel: ANALYSIS_MODEL,
        aiBinding: Boolean(env.AI),
        endpoints: ['/api/test','/api/editorial','/api/media','/api/analysis','/media/news/:hash.jpg','/media/track-v1/:key.jpg'],
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
    if (request.method === 'GET' && (url.pathname.startsWith('/media/news/') || url.pathname.startsWith('/media/track-v1/'))) {
      try {
        return await serveGeneratedImage(request, env);
      } catch (error) {
        return new Response(error instanceof Error ? error.message : String(error), {
          status: 500,
          headers: { "content-type": "text/plain; charset=UTF-8", "cache-control": "no-store", ...corsHeaders },
        });
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
