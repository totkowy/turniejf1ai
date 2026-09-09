interface Env {
  AI: Ai;
  F1_AI_SHARED_SECRET?: string;
}

const MODEL = "@cf/zai-org/glm-4.7-flash";
const SERVICE = "Turniej F1 2026 AI";
const VERSION = "2.0-editorial";

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
  if (!required) return true; // Sekret jest opcjonalny; można go włączyć później bez zmiany kodu.
  return request.headers.get("X-F1-AI-Key") === required;
}

async function editorial(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env)) {
    return json({ ok: false, error: "Brak autoryzacji F1 AI." }, 401);
  }

  const raw = await request.text();
  if (!raw || raw.length > 30000) {
    return json({ ok: false, error: "Nieprawidłowy rozmiar danych wejściowych." }, 400);
  }

  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "Body musi być JSON-em." }, 400);
  }

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

  if (!id || !title || !text) {
    return json({ ok: false, error: "Brakuje ID, tytułu albo treści newsa." }, 400);
  }

  const canonical = JSON.stringify({
    id,
    season,
    title,
    text,
    round,
    category,
    truthEvidence,
    people,
    teams,
    tags,
  });
  const sourceHash = await sha256Hex(canonical);
  const cacheUrl = `${new URL(request.url).origin}/__f1_ai_cache/editorial/${sourceHash}`;
  const cacheKey = new Request(cacheUrl, { method: "GET" });
  const cache = (caches as any).default as Cache;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const cachedBody = await cached.text();
    return new Response(cachedBody, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=UTF-8",
        "cache-control": "no-store",
        "X-F1-AI-Cache": "HIT",
        ...corsHeaders,
      },
    });
  }

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

  try {
    const result: any = await env.AI.run(MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.25,
      max_completion_tokens: 650,
    } as any);

    const modelText = extractModelText(result);
    let parsed: any;
    try {
      parsed = parseJsonObject(modelText);
    } catch {
      return json({ ok: false, error: "AI nie zwróciło poprawnego JSON-u.", model: MODEL }, 422);
    }

    const headline = clean(parsed?.headline, 95);
    const lead = clean(parsed?.lead, 280);
    const paragraphs = stringArray(parsed?.paragraphs, 2, 520);
    if (!headline || !lead || !paragraphs.length) {
      return json({ ok: false, error: "AI zwróciło niepełną redakcję.", model: MODEL }, 422);
    }

    const sourceForNumbers = [season, round, title, text, truthEvidence, people.join(" "), teams.join(" "), tags.join(" ")].join(" ");
    const outputForNumbers = [headline, lead, ...paragraphs].join(" ");
    if (!outputUsesOnlySourceNumbers(sourceForNumbers, outputForNumbers)) {
      return json({ ok: false, error: "AI próbowało dodać liczbę, której nie było w danych źródłowych.", model: MODEL }, 422);
    }
    if (/https?:\/\//i.test(outputForNumbers)) {
      return json({ ok: false, error: "AI zwróciło niedozwolony adres URL.", model: MODEL }, 422);
    }

    const payload = {
      ok: true,
      service: SERVICE,
      version: VERSION,
      model: MODEL,
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

    const responseText = JSON.stringify(payload);
    try {
      await cache.put(
        cacheKey,
        new Response(responseText, {
          headers: {
            "content-type": "application/json; charset=UTF-8",
            "cache-control": "public, max-age=2592000",
          },
        }),
      );
    } catch (_) {
      // Cache jest optymalizacją. Jego błąd nie może zablokować poprawnej redakcji AI.
    }

    return new Response(responseText, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=UTF-8",
        "cache-control": "no-store",
        "X-F1-AI-Cache": "MISS",
        ...corsHeaders,
      },
    });
  } catch (error) {
    return json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      model: MODEL,
    }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        service: SERVICE,
        version: VERSION,
        model: MODEL,
        aiBinding: Boolean(env.AI),
        editorialEndpoint: "/api/editorial",
      });
    }

    if (request.method === "POST" && url.pathname === "/api/test") {
      try {
        const result = await env.AI.run(MODEL, {
          messages: [
            { role: "system", content: "Odpowiadaj krótko i po polsku." },
            { role: "user", content: "Napisz jedno krótkie zdanie potwierdzające, że Turniej F1 AI działa." },
          ],
          temperature: 0.2,
          max_completion_tokens: 100,
        } as any);
        return json({ ok: true, model: MODEL, result });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/editorial") {
      return editorial(request, env);
    }

    return json({ ok: false, error: "Nieznany endpoint." }, 404);
  },
} satisfies ExportedHandler<Env>;
