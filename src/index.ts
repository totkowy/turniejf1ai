interface Env {
  AI: Ai;
  F1_AI_SHARED_SECRET?: string;
}

const EDITORIAL_MODEL = "@cf/zai-org/glm-4.7-flash";
const MEDIA_DIRECTION_MODEL = "@cf/zai-org/glm-4.7-flash";
const MEDIA_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
const ANALYSIS_MODEL = "@cf/zai-org/glm-4.7-flash";
const SERVICE = "Turniej F1 2026 AI";
const VERSION = "4.0-news-engine-3";
const MEDIA_PROMPT_REVISION = "news-v40-news3";
const MEDIA_GUIDANCE = "5.0";

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
  if (!key) return "neutral dark graphite with restrained red accents";
  if (key.includes("MCLAREN")) return "McLaren-inspired papaya orange and deep black, with tiny cool-blue accents only if needed";
  if (key.includes("FERRARI")) return "Ferrari-inspired rich scarlet racing red with restrained black and subtle white details";
  if (key.includes("RED BULL") || key.includes("REDBULL")) return "Red Bull-inspired deep navy blue with vivid red accents and small yellow highlights";
  if (key.includes("MERCEDES")) return "Mercedes-inspired metallic silver and black with turquoise accents";
  if (key.includes("ASTON")) return "Aston Martin-inspired British racing green with restrained lime accents";
  if (key.includes("ALPINE")) return "Alpine-inspired deep blue with restrained pink accents";
  if (key.includes("WILLIAMS")) return "Williams-inspired royal blue and navy with clean white accents";
  if (key.includes("HAAS")) return "Haas-inspired white, black and restrained red";
  if (key.includes("RACING BULL") || key === "RB") return "Racing Bulls-inspired white and dark navy with blue accents";
  if (key.includes("SAUBER")) return "Sauber-inspired black with vivid electric green accents";
  if (key.includes("AUDI")) return "Audi-inspired black, graphite and deep red";
  if (key.includes("CADILLAC")) return "Cadillac-inspired black, white and metallic silver";
  return "professional top-tier Grand Prix racing colors matching the supplied team identity";
}

function teamColorPalette(team: string): string {
  const key = clean(team, 80).toUpperCase().replace(/\s+/g, " ");
  if (!key) return "dark graphite with restrained red accents";
  if (key.includes("MCLAREN")) return "papaya orange and deep black with tiny cool-blue accents";
  if (key.includes("FERRARI")) return "rich scarlet racing red with restrained black and subtle white details";
  if (key.includes("RED BULL") || key.includes("REDBULL")) return "deep navy blue with vivid red accents and small yellow highlights";
  if (key.includes("MERCEDES")) return "metallic silver and black with turquoise accents";
  if (key.includes("ASTON")) return "British racing green with restrained lime accents";
  if (key.includes("ALPINE")) return "deep blue with restrained pink accents";
  if (key.includes("WILLIAMS")) return "royal blue and navy with clean white accents";
  if (key.includes("HAAS")) return "white, black and restrained red";
  if (key.includes("RACING BULL") || key === "RB") return "white and dark navy with blue accents";
  if (key.includes("SAUBER")) return "black with vivid electric green accents";
  if (key.includes("AUDI")) return "black, graphite and deep red";
  if (key.includes("CADILLAC")) return "black, white and metallic silver";
  return "professional dark Grand Prix racing colors with one strong accent color";
}

type NewsPhotoSpec = {
  revision: string;
  sceneType: MediaSceneType;
  color1: string;
  color2: string;
  mood: string;
};

function buildNewsPhotoSpec(input: {
  sceneType: MediaSceneType;
  teams: string[];
  people: string[];
  driverTeams: DriverTeamPair[];
  tone: string;
}): NewsPhotoSpec {
  const team1 = subjectTeam(input, 0) || clean(input.teams[0], 80);
  const team2 = subjectTeam(input, 1) || clean(input.teams[1], 80);
  return {
    revision: MEDIA_PROMPT_REVISION,
    sceneType: input.sceneType,
    color1: teamColorPalette(team1),
    color2: teamColorPalette(team2 || team1),
    mood: slugTone(input.tone),
  };
}

function buildPhotoPromptFromSpec(spec: NewsPhotoSpec, compact = false): string {
  const mood = spec.mood === "alarm" ? "high-pressure competitive tension"
    : spec.mood === "success" ? "controlled confidence and success"
    : spec.mood === "duel" ? "intense elite competition"
    : "focused elite competition";
  const carCore = compact
    ? "modern 2026-era top-level Grand Prix open-wheel single-seat race car, low and wide, halo, slick tyres, exposed suspension, sophisticated wings, realistic current proportions"
    : "modern 2026-era top-level Grand Prix open-wheel single-seat race car: low and wide stance, long nose, halo, large slick tyres, exposed suspension, carbon-fibre floor and sidepods, sophisticated front and rear wings, authentic current-era proportions";
  const photo = compact
    ? "photorealistic professional motorsport photograph, natural perspective, believable track physics, clean editorial framing"
    : "photorealistic premium motorsport editorial photograph, professional long-lens camera, natural perspective, believable scale and track physics, crisp detail, realistic reflections, subtle motion blur, premium magazine color grading";

  const common = [
    photo,
    `Visual era: unmistakably current 2026 top-tier Grand Prix racing. Featured cars must match this shape: ${carCore}.`,
    "Every visible race car is a normal single-seat machine with one cockpit occupied by exactly one helmeted adult driver. Four wheels per car. Distinct separate vehicles and bodies.",
    "No readable words, names, numbers, sponsor marks, logos, captions, watermarks or UI inside the generated photograph.",
    "Wide 2:1 composition. Keep the visual clean, physically believable and suitable for a professional news website.",
    `Mood: ${mood}.`,
  ];

  let scene: string[] = [];
  if (spec.sceneType === "driver_rivalry") {
    scene = [
      "Show exactly two adult Grand Prix racing drivers as the foreground subjects, seen from behind or restrained 3/4 rear angle, walking side by side through a paddock or pit lane.",
      `Driver A race suit palette: ${spec.color1}. Driver B race suit palette: ${spec.color2}. Keep the two palettes clearly separated and correctly assigned.`,
      "Cars, mechanics and spectators may appear only as soft background context; no third foreground driver.",
    ];
  } else if (spec.sceneType === "two_car_duel") {
    scene = [
      "Show exactly two complete separate modern Grand Prix single-seaters racing wheel-to-wheel through a realistic circuit corner, with believable racing lines and visible separation between both cars.",
      `Car A livery palette: ${spec.color1}. Car B livery palette: ${spec.color2}. Do not swap the palettes.`,
      "Each of the two cars has its own single cockpit and one helmeted driver. No passenger, no tandem seating, no merged bodywork, no third featured car.",
    ];
  } else if (spec.sceneType === "single_driver") {
    scene = [
      "Show exactly one adult Grand Prix racing driver as the foreground hero, seen from behind or 3/4 rear angle in a paddock or pit lane.",
      `Race suit palette: ${spec.color1}.`,
      "At most one matching modern single-seater may appear softly in the background. No second featured driver.",
    ];
  } else if (spec.sceneType === "team_cars") {
    scene = [
      "Show one or two complete modern Grand Prix single-seaters from the same team in a disciplined professional team-performance scene.",
      `Both cars use the same livery palette: ${spec.color1}.`,
      "If two cars are visible, each is a separate normal single-seat car with one driver and four wheels.",
    ];
  } else {
    scene = [
      "Show exactly one complete modern Grand Prix single-seater as the main subject in realistic on-track action.",
      `Livery palette: ${spec.color1}.`,
      "One cockpit, one helmeted driver, four wheels, realistic open-wheel proportions.",
    ];
  }

  const quality = compact ? [
    "Avoid unusual vehicle concepts, retro racing cars, junior formulas, karts, road cars and fantasy designs.",
  ] : [
    "Quality control: no duplicated helmets, extra occupants, extra wheels, fused cars, malformed suspension, toy-like proportions, retro formula styling, junior-series styling, karts, sports cars or fantasy vehicles.",
    "For cars, the nose, halo, cockpit, front wing, sidepods, floor, rear wing, suspension and tyre scale must form one coherent physically plausible race car.",
  ];

  return clean([...common, ...scene, ...quality].join(" "), compact ? 1800 : 3000);
}

function imageErrorText(error: unknown): string {
  if (error instanceof Error) return clean(error.message, 800);
  try { return clean(JSON.stringify(error), 800); } catch { return clean(String(error), 800); }
}

function isImageSafetyFlag(error: unknown): boolean {
  const t = imageErrorText(error).toLowerCase();
  return t.includes("3030") || t.includes("flagged") || t.includes("choose another prompt") || t.includes("safety");
}

function isImageHardStop(error: unknown): boolean {
  const t = imageErrorText(error).toLowerCase();
  return t.includes("3036") || t.includes("daily free allocation") || t.includes("3040") || t.includes("out of capacity") || t.includes("429");
}

function imageAttemptSeed(seedHash: string, attempt: number): number {
  const base = deterministicSeed(seedHash);
  return (base + Math.imul(attempt + 1, 104729)) & 0x7fffffff;
}

type MediaSceneType = "single_driver" | "driver_rivalry" | "single_car" | "two_car_duel" | "team_cars";
type DriverTeamPair = { name: string; team: string };

function stableBucket(value: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 100;
}

function normalizeSceneType(value: unknown): MediaSceneType | "" {
  const v = clean(value, 40).toLowerCase();
  if (["single_driver", "driver_rivalry", "single_car", "two_car_duel", "team_cars"].includes(v)) return v as MediaSceneType;
  return "";
}

function resolveSceneType(input: {
  title: string;
  text: string;
  category: string;
  family: string;
  people: string[];
  teams: string[];
  requested?: unknown;
}): MediaSceneType {
  const requested = normalizeSceneType(input.requested);
  const peopleCount = input.people.length;
  const teamCount = input.teams.length;
  const story = clean(`${input.family} ${input.category} ${input.title} ${input.text}`, 1800).toLowerCase();
  const bucket = stableBucket(`${input.family}|${input.title}|${input.people.join("|")}|${input.teams.join("|")}`);
  const onTrack = /(walka|pojedynek|duel|battle|różnic|roznic|swing|dogoni|atak|wyprzed|koło w koło|kolo w kolo|p10|p9|p8|p7|p6|p5|p4|gap)/i.test(story);
  const humanStory = /(mistrz|tytuł|tytul|lider|presj|forma|zagroż|zagroz|elimin|rekord|awans|spad|momentum|podium|bohater)/i.test(story);

  if (peopleCount >= 2) {
    if (requested === "driver_rivalry" || requested === "two_car_duel") return requested;
    if (onTrack && !humanStory) return "two_car_duel";
    if (humanStory && !onTrack) return "driver_rivalry";
    return bucket < 48 ? "driver_rivalry" : "two_car_duel";
  }
  if (peopleCount === 1) {
    if (requested === "single_driver" || requested === "single_car") return requested;
    if (humanStory) return "single_driver";
    if (onTrack) return "single_car";
    return bucket < 58 ? "single_driver" : "single_car";
  }
  if (teamCount >= 2) return "two_car_duel";
  if (teamCount === 1) return requested === "single_car" ? "single_car" : "team_cars";
  return "single_car";
}

function driverTeamLookup(driverTeams: DriverTeamPair[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of driverTeams) {
    const name = clean(pair?.name, 80).toLowerCase();
    const team = clean(pair?.team, 80);
    if (name && team) map.set(name, team);
  }
  return map;
}

function subjectTeam(input: { people: string[]; teams: string[]; driverTeams: DriverTeamPair[] }, index: number): string {
  const person = clean(input.people[index], 80);
  const lookup = driverTeamLookup(input.driverTeams);
  if (person) {
    const mapped = lookup.get(person.toLowerCase());
    if (mapped) return mapped;
  }
  return clean(input.teams[index] || (index === 0 ? input.teams[0] : ""), 80);
}

function sceneInstructions(sceneType: MediaSceneType, input: {
  people: string[];
  teams: string[];
  driverTeams: DriverTeamPair[];
}): string[] {
  const person1 = clean(input.people[0], 80) || "the primary league driver";
  const person2 = clean(input.people[1], 80) || "the second rival driver";
  const team1 = subjectTeam(input, 0) || clean(input.teams[0], 80);
  const team2 = subjectTeam(input, 1) || clean(input.teams[1], 80);
  const livery1 = teamLiveryDescription(team1);
  const livery2 = teamLiveryDescription(team2);
  const mapping: string[] = [];
  if (input.people[0] && team1) mapping.push(`SUBJECT MAPPING — ${person1} belongs to ${team1}: use ${livery1}. This mapping is mandatory.`);
  if (input.people[1] && team2) mapping.push(`SUBJECT MAPPING — ${person2} belongs to ${team2}: use ${livery2}. This mapping is mandatory and MUST NOT be swapped with subject 1.`);

  if (sceneType === "driver_rivalry") {
    return [
      ...mapping,
      "SCENE: premium championship-rivalry paddock photograph.",
      "Show EXACTLY TWO foreground racing drivers, no more and no fewer. Both are adult professional Grand Prix drivers, seen from behind or from a restrained 3/4 rear angle, walking side-by-side through the paddock or pit lane.",
      `Driver 1 visually represents ${person1}${team1 ? ` / ${team1}` : ""} and wears a race suit dominated by ${livery1}.`,
      `Driver 2 visually represents ${person2}${team2 ? ` / ${team2}` : ""} and wears a race suit dominated by ${livery2}.`,
      "The two suits must be clearly different and correctly assigned; NEVER swap their team colors.",
      "Keep faces non-identifiable; helmets may be worn. No readable driver names, numbers or sponsor logos.",
      "Cars may appear only softly in the background and must not obscure the two drivers. No extra foreground mechanics or third featured driver.",
      "Mood: elite championship tension, serious and believable, like a premium motorsport magazine photograph."
    ];
  }
  if (sceneType === "two_car_duel") {
    return [
      ...mapping,
      "SCENE: realistic wheel-to-wheel Grand Prix battle on a proper racing circuit.",
      "Show EXACTLY TWO complete modern 2026-era Formula One-style single-seater cars as the featured subjects. Do not merge the cars and do not add a third featured car.",
      `Car 1 represents ${person1}${team1 ? ` / ${team1}` : ""}: its livery must be ${livery1}.`,
      `Car 2 represents ${person2}${team2 ? ` / ${team2}` : ""}: its livery must be ${livery2}.`,
      "Each car has EXACTLY ONE cockpit, EXACTLY ONE seat, EXACTLY ONE steering wheel and EXACTLY ONE helmeted driver. One human per car, never two people in one cockpit.",
      "Place the cars side-by-side or nose-to-tail under braking through a realistic medium/high-speed circuit corner, with believable racing lines and separation between vehicles.",
      "No passenger, no tandem seating, no two-seater, no duplicated helmet, no person sitting behind the driver."
    ];
  }
  if (sceneType === "single_driver") {
    return [
      ...mapping,
      "SCENE: premium single-driver editorial portrait in the paddock or pit lane.",
      "Show EXACTLY ONE foreground racing driver as the hero subject, adult, athletic, seen from behind or 3/4 rear angle, professional and calm.",
      `The driver represents ${person1}${team1 ? ` / ${team1}` : ""} and wears a race suit dominated by ${livery1}.`,
      "Optionally show ONE matching modern Formula One-style car softly in the background. Do not introduce a second featured driver.",
      "Keep the face non-identifiable; no readable names, numbers or sponsor logos."
    ];
  }
  if (sceneType === "team_cars") {
    const baseTeam = clean(input.teams[0], 80) || team1;
    const baseLivery = teamLiveryDescription(baseTeam);
    return [
      "SCENE: premium team-performance editorial photograph.",
      `Feature one or two modern 2026-era Formula One-style cars from ${baseTeam || "the same team"}, consistently using ${baseLivery}.`,
      "If two cars are shown, each car has EXACTLY ONE cockpit and EXACTLY ONE helmeted driver. Never create a shared or tandem cockpit.",
      "Keep the composition disciplined and professional, with the same team identity on both cars and no unrelated rival livery dominating the frame."
    ];
  }
  return [
    ...mapping,
    "SCENE: premium single-car Grand Prix action photograph.",
    "Show EXACTLY ONE complete modern 2026-era Formula One-style single-seater as the featured car.",
    `The car represents ${person1}${team1 ? ` / ${team1}` : ""} and its livery must be ${livery1}.`,
    "The car has EXACTLY ONE cockpit, EXACTLY ONE seat, EXACTLY ONE steering wheel and EXACTLY ONE helmeted driver.",
    "No second featured driver, no passenger, no tandem seating and no extra cockpit."
  ];
}

function buildNewsPhotoPrompt(input: {
  title: string;
  text: string;
  round: string;
  category: string;
  family: string;
  people: string[];
  teams: string[];
  driverTeams: DriverTeamPair[];
  tone: string;
  requestedSceneType?: unknown;
}) {
  const sceneType = resolveSceneType({
    title: input.title,
    text: input.text,
    category: input.category,
    family: input.family,
    people: input.people,
    teams: input.teams,
    requested: input.requestedSceneType,
  });
  const narrative = clean(`${input.title}. ${input.text}`, 420);
  const scene = sceneInstructions(sceneType, input);
  const mood = slugTone(input.tone);
  const moodLine = mood === "alarm"
    ? "Mood: high pressure and tension, physically believable; no crash unless the story explicitly says so."
    : mood === "success"
      ? "Mood: confident and triumphant but documentary, not fantasy."
      : mood === "duel"
        ? "Mood: intense elite competition, like a decisive Grand Prix weekend."
        : "Mood: focused, modern, elite Grand Prix competition.";

  return clean([
    "PHOTOREALISTIC PREMIUM 2026 FORMULA ONE-STYLE EDITORIAL SPORTS PHOTOGRAPH. It must look like a real current top-tier Grand Prix photograph, never an illustration or junior-series image.",
    "2026 F1 CAR SHAPE IS MANDATORY: low, wide, long-nose open-wheel single-seater; large slick tyres; halo; carbon-fibre sidepods and floor; sophisticated front wing; large rear wing; exposed suspension; authentic present-day Formula One proportions.",
    "VEHICLE INTEGRITY: exactly 4 wheels, 1 cockpit, 1 seat, 1 steering wheel and maximum 1 helmeted driver per car. NEVER passenger seat, tandem cockpit, two people in one car, second person behind the driver, duplicate helmet, duplicate torso, extra steering wheel or fused cars.",
    "FORBIDDEN VEHICLES: go-kart, kart, Formula 2, Formula 3, Formula 4, Formula Ford, IndyCar, vintage Formula car, retro race car, road supercar, prototype, sports car, toy, child-sized car, sci-fi car or two-seater experience car.",
    ...scene,
    moodLine,
    narrative ? `ARTICLE CONTEXT: ${narrative}` : "",
    input.round ? `RACE CONTEXT: ${clean(input.round, 100)}.` : "",
    "TEAM COLORS: obey the supplied driver-to-team mapping exactly. Correct team-inspired colors matter more than exact logos. NEVER swap rival colors and never invent a dominant third-team livery.",
    "PHOTO STYLE: professional motorsport camera, natural perspective, realistic scale and track physics, crisp subject detail, believable reflections, subtle physical motion blur, premium magazine lighting and color grading.",
    "COMPOSITION: clean wide 2:1 news image. Keep featured subjects center-right/right when practical; preserve calmer negative space on the left for website headlines. Do not crop the key wheels or driver and do not let one oversized subject fill the entire frame.",
    "HUMAN INTEGRITY: realistic adult anatomy, correct limbs and helmet placement, no duplicate/fused bodies. Foreground driver count must match the scene instruction exactly.",
    "NO TEXT IN IMAGE: no readable words, names, numbers, team names, sponsor marks, logos, captions, UI, badges, watermarks or pseudo-text. Website text is rendered separately.",
    "FINAL CHECK: exact subject count, one driver maximum per cockpit, unmistakable 2026 Formula One proportions, correct team-color assignment, realistic anatomy and no forbidden vehicle type."
  ].filter(Boolean).join(" "), 4000);
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

async function fluxImageBytes(env: Env, prompt: string, seedHash: string, attempt = 0): Promise<Uint8Array> {
  const form = new FormData();
  form.append("prompt", prompt);
  form.append("width", "1024");
  form.append("height", "512");
  form.append("guidance", MEDIA_GUIDANCE);
  form.append("seed", String(imageAttemptSeed(seedHash, attempt)));
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
  const bytes = base64ToBytes(image);
  if (bytes.length < 5000) throw new Error("Model obrazu zwrócił nieprawidłowo mało danych obrazu.");
  return bytes;
}

async function generateValidatedImage(env: Env, prompts: string[], seedHash: string): Promise<{ bytes: Uint8Array; promptIndex: number; attempt: number }> {
  const errors: string[] = [];
  let attempt = 0;
  for (let promptIndex = 0; promptIndex < prompts.length; promptIndex++) {
    const prompt = clean(prompts[promptIndex], 3200);
    const seedsForPrompt = promptIndex === 0 ? 2 : 1;
    for (let seedTry = 0; seedTry < seedsForPrompt; seedTry++) {
      try {
        const bytes = await fluxImageBytes(env, prompt, seedHash, attempt);
        return { bytes, promptIndex, attempt };
      } catch (error) {
        const text = imageErrorText(error);
        errors.push(`p${promptIndex + 1}/s${seedTry + 1}: ${text}`);
        if (isImageHardStop(error)) throw error;
        // 3030 / output flagged: zmieniamy seed, a następnie przechodzimy na prostszy prompt.
        // Dla innych pojedynczych błędów również dajemy tylko ograniczoną liczbę prób.
      }
      attempt++;
    }
  }
  throw new Error(`Generowanie zdjęcia AI nie przeszło walidacji po ${attempt} próbach. ${errors.join(" | ").slice(0, 1400)}`);
}

function imageResponse(bytes: Uint8Array, extra: Record<string, string> = {}): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": imageMimeType(bytes),
      "cache-control": "public, max-age=31536000, immutable",
      "Access-Control-Allow-Origin": "*",
      "X-F1-AI-Image-Model": MEDIA_MODEL,
      "X-F1-AI-Generated": "1",
      ...extra,
    },
  });
}

async function generateAndCacheImage(cacheKey: Request, cache: Cache, env: Env, prompts: string[], seedHash: string): Promise<{ bytes: Uint8Array; promptIndex: number; attempt: number }> {
  const generated = await generateValidatedImage(env, prompts, seedHash);
  const response = imageResponse(generated.bytes, {
    "X-F1-AI-Prompt-Variant": String(generated.promptIndex + 1),
    "X-F1-AI-Attempt": String(generated.attempt + 1),
  });
  try { await cache.put(cacheKey, response.clone()); } catch (_) {}
  return generated;
}

async function serveGeneratedImage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const cache = (caches as any).default as Cache;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let prompts: string[] = [];
  let seedHash = "";

  if (url.pathname.startsWith("/media/news-v40/") || url.pathname.startsWith("/media/news-v35/")) {
    const match = url.pathname.match(/^\/media\/(?:news-v40|news-v35)\/([a-f0-9]{64})\.jpg$/);
    if (!match) return new Response("Not found", { status: 404 });
    const encoded = url.searchParams.get("s") || "";
    if (!encoded || encoded.length > 5000) return new Response("Invalid image specification", { status: 400 });
    let spec: NewsPhotoSpec;
    try { spec = JSON.parse(base64UrlDecodeUtf8(encoded)); } catch { return new Response("Invalid image specification", { status: 400 }); }
    const specJson = JSON.stringify(spec);
    const requestedRevision = clean(spec.revision, 80);
    const isV40 = url.pathname.startsWith("/media/news-v40/");
    const allowedRevision = isV40 ? requestedRevision === MEDIA_PROMPT_REVISION : requestedRevision === "news-v35";
    const actualHash = await sha256Hex(`${requestedRevision}:${specJson}`);
    if (actualHash !== match[1] || !allowedRevision) return new Response("Invalid image signature", { status: 400 });
    prompts = [buildPhotoPromptFromSpec(spec, false), buildPhotoPromptFromSpec(spec, true)];
    seedHash = actualHash;
  } else if (url.pathname.startsWith("/media/news/")) {
    // Backward compatibility dla wcześniej zapisanych linków v34.
    const match = url.pathname.match(/^\/media\/news\/([a-f0-9]{64})\.jpg$/);
    if (!match) return new Response("Not found", { status: 404 });
    const encoded = url.searchParams.get("p") || "";
    if (!encoded || encoded.length > 6000) return new Response("Invalid image prompt", { status: 400 });
    let prompt = "";
    try { prompt = base64UrlDecodeUtf8(encoded); } catch { return new Response("Invalid image prompt", { status: 400 }); }
    const actualHash = await sha256Hex(prompt);
    if (actualHash !== match[1]) return new Response("Invalid image signature", { status: 400 });
    prompts = [prompt];
    seedHash = actualHash;
  } else {
    const match = url.pathname.match(/^\/media\/track-v1\/([a-z0-9-]{2,40})\.jpg$/);
    if (!match) return new Response("Not found", { status: 404 });
    const prompt = buildTrackPhotoPrompt(match[1]) || "";
    if (!prompt) return new Response("Unknown track", { status: 404 });
    prompts = [prompt, clean(`Photorealistic wide aerial motorsport photograph of a modern racing circuit at ${match[1].replace(/-/g, " ")}. The asphalt circuit is the clear main subject with realistic kerbs, barriers, pit buildings and grandstands. Clean believable professional drone photography. No text, logos or labels.`, 900)];
    seedHash = await sha256Hex(`track-v1:${match[1]}:${prompt}`);
  }

  const generated = await generateAndCacheImage(cacheKey, cache, env, prompts, seedHash);
  return imageResponse(generated.bytes, {
    "X-F1-AI-Prompt-Variant": String(generated.promptIndex + 1),
    "X-F1-AI-Attempt": String(generated.attempt + 1),
  });
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
  if (!raw || raw.length > 42000) return json({ ok: false, error: "Nieprawidłowy rozmiar danych wejściowych." }, 400);

  let body: any;
  try { body = JSON.parse(raw); } catch { return json({ ok: false, error: "Body musi być JSON-em." }, 400); }

  const event = body?.event || {};
  const id = clean(event.id, 220);
  const title = clean(event.title, 500);
  const text = clean(event.text, 1200);
  const round = clean(event.round, 180);
  const category = clean(event.category, 80);
  const truthEvidence = clean(event.truthEvidence, 3500);
  const season = clean(body?.season, 40);
  const people = stringArray(event.people, 8, 80);
  const teams = stringArray(event.teams, 8, 80);
  const tags = stringArray(event.tags, 10, 80);
  const editorialMode = clean(event.editorialMode || "NEWS", 40).toUpperCase();
  const storylineId = clean(event.storylineId, 120);
  const storylineTitle = clean(event.storylineTitle, 300);
  const memoryContext = clean(event.memoryContext, 2200);
  const updateType = clean(event.updateType || "NEW", 40).toUpperCase();
  const followUpOf = clean(event.followUpOf, 220);
  const claimClasses = stringArray(event.claimClasses, 8, 40).map((x) => x.toUpperCase());
  const evidence = event?.evidence && typeof event.evidence === "object" ? event.evidence : {};
  const scenario = event?.scenario && typeof event.scenario === "object" ? event.scenario : null;
  const scores = event?.scores && typeof event.scores === "object" ? event.scores : {};
  if (!id || !title || !text) return json({ ok: false, error: "Brakuje ID, tytułu albo treści newsa." }, 400);

  const canonical = JSON.stringify({ id, season, title, text, round, category, truthEvidence, people, teams, tags, editorialMode, storylineId, storylineTitle, memoryContext, updateType, followUpOf, claimClasses, evidence, scenario, scores });
  const sourceHash = await sha256Hex(canonical);
  const cached = await withCache(request, `editorial-v40/${sourceHash}`, async () => {
    const styleByMode: Record<string, string> = {
      BREAKING: "BREAKING: bardzo zwięźle i pilnie, ale bez clickbaitu, spekulacji i wykrzyknikowej przesady.",
      ANALYSIS: "ANALIZA: możesz wyjaśniać znaczenie dostarczonych faktów, ale każda interpretacja musi wynikać wprost z evidence/scenario i nie może udawać nowego faktu.",
      PADDOCK: "PADDOCK: dopuszczalna jest opinia wyłącznie wtedy, gdy claimClasses zawiera OPINIA; opinię jawnie oznacz jako ocenę/redakcyjny punkt widzenia. Nie twórz plotek.",
      POWER_RANKING: "POWER RANKING: dynamiczny ton rankingowy, ale nie wymyślaj pozycji ani ocen niewystępujących w wejściu.",
      WEEKEND_PREVIEW: "WEEKEND PREVIEW: przedstaw, na co patrzeć przed rundą. Nie przewiduj zwycięzcy i nie dopisuj pogody, toru ani strategii, jeśli nie ma ich w danych.",
      POST_RACE: "POST-RACE: czytelne podsumowanie faktów po rundzie, nacisk na wynik i wpływ na tabelę obecny w evidence.",
      CHAMPIONSHIP_SCENARIO: "SCENARIUSZ: opisuj wyłącznie deterministyczne wyliczenie przekazane w scenario. Zachowaj wszystkie zastrzeżenia, w tym informację o tie-breaku.",
      NEWS: "NEWS: neutralny, profesjonalny materiał informacyjny.",
    };
    const system = [
      "Jesteś redaktorem oficjalnego newsroomu amatorskiej ligi wyścigowej Turniej F1 2026.",
      "Pracujesz jako ostatnia warstwa językowa po backendowym News Engine 3.0 i kontrakcie Truth Guard.",
      "Nie jesteś źródłem faktów. Nie wolno Ci dodawać żadnych nowych wyników, liczb, nazwisk, zespołów, torów, przyczyn, cytatów, przewidywań ani zdarzeń.",
      "FAKT i WYLICZENIE mogą pochodzić wyłącznie z ORYGINALNEGO TYTUŁU/LEADU, DOWODÓW, EVIDENCE lub SCENARIO.",
      "INTERPRETACJA jest dozwolona tylko, jeśli claimClasses ją dopuszcza, i musi być przedstawiona jako interpretacja, a nie nowy fakt.",
      "OPINIA jest dozwolona tylko, jeśli claimClasses zawiera OPINIA. Musi być jawnie oznaczona jako opinia/ocena redakcji.",
      "MEMORY CONTEXT służy wyłącznie do ciągłości narracji i rozpoznania follow-upu. Nie wolno kopiować z niego liczby lub faktu, którego nie ma w bieżących dowodach.",
      "News Score i jego składowe są metadanymi redakcyjnymi. Nie cytuj ich w artykule.",
      "Jeśli updateType to FOLLOW_UP lub UPDATE, napisz materiał jak kontynuację, ale nie zakładaj, że czytelnik zna poprzedni artykuł.",
      styleByMode[editorialMode] || styleByMode.NEWS,
      "Pisz naturalnie po polsku, sportowo i profesjonalnie.",
      "Zwróć WYŁĄCZNIE poprawny JSON bez markdownu w formacie: {\"headline\":\"...\",\"lead\":\"...\",\"paragraphs\":[\"...\",\"...\"]}.",
      "headline: maks. 95 znaków; lead: maks. 280 znaków; paragraphs: 1-2 akapity, każdy maks. 520 znaków.",
    ].join("\n");

    const evidenceText = clean(JSON.stringify(evidence), 6000);
    const scenarioText = scenario ? clean(JSON.stringify(scenario), 4000) : "brak";
    const user = [
      `SEZON: ${season || "brak"}`,
      `ID: ${id}`,
      `TRYB REDAKCYJNY: ${editorialMode}`,
      `UPDATE TYPE: ${updateType}`,
      `FOLLOW-UP OF: ${followUpOf || "brak"}`,
      `STORYLINE: ${storylineTitle || "brak"} (${storylineId || "brak ID"})`,
      `CLAIM CLASSES: ${claimClasses.join(", ") || "FAKT"}`,
      `RUNDA: ${round || "brak"}`,
      `KATEGORIA: ${category || "news"}`,
      `OSOBY DOZWOLONE: ${people.join(", ") || "brak"}`,
      `ZESPOŁY DOZWOLONE: ${teams.join(", ") || "brak"}`,
      `TAGI: ${tags.join(", ") || "brak"}`,
      `ORYGINALNY TYTUŁ: ${title}`,
      `ORYGINALNY LEAD: ${text}`,
      `DOWODY TRUTH GUARD: ${truthEvidence || "brak dodatkowych dowodów"}`,
      `EVIDENCE NEWS ENGINE 3.0: ${evidenceText || "brak"}`,
      `SCENARIO DETERMINISTYCZNE: ${scenarioText}`,
      `MEMORY CONTEXT (tylko ciągłość, nie nowe fakty): ${memoryContext || "brak"}`,
      `METADANE SCORE (nie cytuj): ${clean(JSON.stringify(scores), 800)}`,
      "Przeredaguj ten materiał zgodnie z trybem. Nie dopisuj niczego spoza bieżących źródeł faktów.",
    ].join("\n");

    const parsed = await runStructured(
      env,
      EDITORIAL_MODEL,
      [
        { role: "system", content: system },
        { role: "user", content: user + "\nZakończ odpowiedź wywołaniem narzędzia submitEditorial." },
      ],
      "submitEditorial",
      "Zwróć gotową, bezpieczną redakcję newsa opartą wyłącznie na faktach i wyliczeniach zatwierdzonych przez News Engine 3.0.",
      {
        type: "object",
        properties: {
          headline: { type: "string" },
          lead: { type: "string" },
          paragraphs: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 },
        },
        required: ["headline", "lead", "paragraphs"],
      },
      1000,
    );
    const headline = clean(parsed?.headline, 95);
    const lead = clean(parsed?.lead, 280);
    const paragraphs = stringArray(parsed?.paragraphs, 2, 520);
    if (!headline || !lead || !paragraphs.length) throw new Error("AI zwróciło niepełną redakcję.");
    // Celowo NIE dokładamy memoryContext ani scores do źródła liczb. AI może je widzieć jako metadane,
    // ale nowa liczba w tekście musi pochodzić z aktualnego faktu/evidence/scenario.
    const sourceForNumbers = [season, round, title, text, truthEvidence, JSON.stringify(evidence), JSON.stringify(scenario || {}), people.join(" "), teams.join(" "), tags.join(" ")].join(" ");
    const outputForNumbers = [headline, lead, ...paragraphs].join(" ");
    if (!outputUsesOnlySourceNumbers(sourceForNumbers, outputForNumbers)) throw new Error("AI próbowało dodać liczbę, której nie było w bieżących danych źródłowych.");
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
        mode: editorialMode,
        updateType,
        storylineId,
        factsVerifiedBy: "News Engine 3.0 / Truth Guard contract",
        source: "News Engine 3.0",
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
  const family = clean(event.family, 120);
  const truthEvidence = clean(event.truthEvidence, 1400);
  const season = clean(body?.season, 40);
  const people = stringArray(event.people, 6, 80);
  const teams = stringArray(event.teams, 6, 80);
  const driverTeams: DriverTeamPair[] = Array.isArray(event.driverTeams)
    ? event.driverTeams.map((x: any) => ({ name: clean(x?.name, 80), team: clean(x?.team, 80) })).filter((x: DriverTeamPair) => x.name && x.team).slice(0, 6)
    : [];
  const tags = stringArray(event.tags, 10, 60);
  const editorialMode = clean(event.editorialMode || "NEWS", 40).toUpperCase();
  const storylineTitle = clean(event.storylineTitle, 300);
  const memoryContext = clean(event.memoryContext, 1800);
  const scenario = event?.scenario && typeof event.scenario === "object" ? event.scenario : null;
  const scores = event?.scores && typeof event.scores === "object" ? event.scores : {};
  if (!id || !title || !text) return json({ ok: false, error: "Brakuje ID, tytułu albo treści newsa." }, 400);

  const canonical = JSON.stringify({ id, season, title, text, round, category, family, truthEvidence, people, teams, driverTeams, tags, editorialMode, storylineTitle, memoryContext, scenario, scores, mediaPromptRevision: MEDIA_PROMPT_REVISION });
  const sourceHash = await sha256Hex(canonical);
  const cached = await withCache(request, `media-v40/${sourceHash}`, async () => {
    const system = [
      "Jesteś dyrektorem wizualnym profesjonalnego newsroomu ligi Turniej F1 2026.",
      "Nie ustalasz faktów. Nie dodawaj żadnych nowych nazw, zespołów, torów, wyników ani liczb.",
      "Masz wybrać sensowny typ realistycznej fotografii, który odpowiada znaczeniu newsa, trybowi redakcyjnemu i liczbie bohaterów.",
      "Storyline, memoryContext i scores są kontekstem kompozycyjnym. Nie są zgodą na dodawanie faktów, tekstu, symboli punktowych ani fikcyjnych zdarzeń.",
      "Dla dwóch rywali wybieraj driver_rivalry albo two_car_duel. Dla jednego kierowcy wybieraj single_driver albo single_car. Dla newsa o jednym zespole bez wskazanego kierowcy możesz wybrać team_cars.",
      "driver_rivalry oznacza dokładnie dwóch kierowców na pierwszym planie, najlepiej od tyłu/3-4 tyłem w paddocku. two_car_duel oznacza dokładnie dwa osobne bolidy i po jednym kierowcy w każdym kokpicie.",
      "Preferuj kierowców dla historii o mistrzostwie, liderze, presji, formie i narracji osobowej. Preferuj bolidy dla bezpośredniej walki, różnicy punktowej, ataku, pojedynku i sceny torowej. Zachowuj różnorodność między newsami.",
      "Finalny model obrazu dostanie osobny bardzo restrykcyjny prompt: nie próbuj dodawać tekstu ani logo do grafiki.",
      "Zwróć dane przez narzędzie: strapline, focusTitle, focus, tone oraz sceneType.",
      "strapline max 160 znaków, focusTitle max 40 znaków, focus do 2 krótkich haseł.",
    ].join("\n");
    const user = [
      `SEZON: ${season || 'brak'}`,
      `TYTUŁ: ${title}`,
      `LEAD: ${text}`,
      `RUNDA: ${round || 'brak'}`,
      `KATEGORIA: ${category || 'news'}`,
      `TRYB REDAKCYJNY: ${editorialMode}`,
      `STORYLINE: ${storylineTitle || 'brak'}`,
      `RODZINA NEWSA: ${family || 'brak'}`,
      `OSOBY: ${people.join(', ') || 'brak'}`,
      `ZESPOŁY: ${teams.join(', ') || 'brak'}`,
      `PRZYPISANIE KIEROWCA→ZESPÓŁ: ${driverTeams.map(x=>`${x.name}→${x.team}`).join(' | ') || 'brak'}`,
      `TAGI: ${tags.join(', ') || 'brak'}`,
      `DOWODY: ${truthEvidence || 'brak'}`,
      `SCENARIUSZ: ${scenario ? clean(JSON.stringify(scenario), 2200) : 'brak'}`,
      `MEMORY (tylko ciągłość wizualna): ${memoryContext || 'brak'}`,
      `NEWS SCORE (tylko priorytet kompozycyjny, nie pokazuj jako tekst): ${clean(JSON.stringify(scores), 600)}`,
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
          sceneType: { type: "string", enum: ["single_driver", "driver_rivalry", "single_car", "two_car_duel", "team_cars"] },
        },
        required: ["strapline", "focusTitle", "focus", "tone", "sceneType"],
      },
      650,
    );
    const strapline = clean(parsed?.strapline || text, 160) || title;
    const focusTitle = clean(parsed?.focusTitle || category || 'Turniej F1', 40);
    const focus = stringArray(parsed?.focus, 2, 34);
    const tone = clean(parsed?.tone || 'neutral', 20).toLowerCase();
    const sceneType = resolveSceneType({ title, text, category, family, people, teams, requested: parsed?.sceneType });
    const sourceForNumbers = [season, title, text, round, category, truthEvidence, JSON.stringify(scenario || {}), people.join(" "), teams.join(" "), tags.join(" ")].join(" ");
    const outputForNumbers = [strapline, focusTitle, ...focus].join(" ");
    if (!outputUsesOnlySourceNumbers(sourceForNumbers, outputForNumbers)) throw new Error("AI visual próbowało dodać nową liczbę.");
    const photoSpec = buildNewsPhotoSpec({ sceneType, teams, people, driverTeams, tone });
    const specJson = JSON.stringify(photoSpec);
    const imageHash = await sha256Hex(`${MEDIA_PROMPT_REVISION}:${specJson}`);
    const origin = new URL(request.url).origin;
    const imageDataUri = `${origin}/media/news-v40/${imageHash}.jpg?s=${encodeURIComponent(base64UrlEncodeUtf8(specJson))}`;

    // V3.5: READY dopiero po faktycznym wygenerowaniu i zapisaniu poprawnego obrazu do cache.
    // To naprawia sytuację, w której arkusz pokazywał READY, a dopiero przeglądarka trafiała na 3030/flagged.
    const imageCache = (caches as any).default as Cache;
    const imageCacheKey = new Request(imageDataUri, { method: "GET" });
    let prewarmed = await imageCache.match(imageCacheKey);
    let imageValidation = { promptIndex: 0, attempt: 0 };
    if (!prewarmed) {
      const prompts = [buildPhotoPromptFromSpec(photoSpec, false), buildPhotoPromptFromSpec(photoSpec, true)];
      const generated = await generateAndCacheImage(imageCacheKey, imageCache, env, prompts, imageHash);
      imageValidation = { promptIndex: generated.promptIndex, attempt: generated.attempt };
      prewarmed = await imageCache.match(imageCacheKey);
    }
    if (!prewarmed) throw new Error("Zdjęcie AI wygenerowało się, ale nie udało się zapisać go w cache Workera.");

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
        sceneType,
        promptRevision: MEDIA_PROMPT_REVISION,
        label: 'AI FOTO • wygenerowane przez AI',
        factsVerifiedBy: 'News Engine 3.0 / Truth Guard contract',
        source: 'News Engine 3.0',
        directionModel: MEDIA_DIRECTION_MODEL,
        imageModel: MEDIA_MODEL,
        imageValidated: true,
        imagePromptVariant: imageValidation.promptIndex + 1,
        imageAttempt: imageValidation.attempt + 1,
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
  if (!raw || raw.length > 36000) return json({ ok: false, error: "Nieprawidłowy rozmiar danych wejściowych." }, 400);
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
  const scenarios = Array.isArray(body?.scenarios) ? body.scenarios.slice(0, 6).map((x: any) => ({
    type: clean(x?.type, 60), driver: clean(x?.driver, 80), leader: clean(x?.leader, 80), challenger: clean(x?.challenger, 80), currentGap: Number(x?.currentGap ?? 0),
    neededSwing: Number(x?.neededSwing ?? 0), maxSingleRaceSwing: Number(x?.maxSingleRaceSwing ?? 0), possibleOnPoints: Boolean(x?.possibleOnPoints),
    mathematicallyAlive: x?.mathematicallyAlive === undefined ? undefined : Boolean(x?.mathematicallyAlive), maxRemainingSwing: Number(x?.maxRemainingSwing ?? 0),
    requiredGapAfterNext: Number(x?.requiredGapAfterNext ?? 0), neededGainNextRace: Number(x?.neededGainNextRace ?? 0), remainingAfterNext: Number(x?.remainingAfterNext ?? 0), maxPointsAfterNext: Number(x?.maxPointsAfterNext ?? 0),
    nextRound: Number(x?.nextRound ?? 0), nextRace: clean(x?.nextRace, 120), tieBreakerIncluded: Boolean(x?.tieBreakerIncluded), text: clean(x?.text, 600),
  })) : [];
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
    scenarios,
  };
  if (!sourceObject.leader.name) return json({ ok: false, error: "Brak danych lidera do analizy AI." }, 400);

  const sourceHash = await sha256Hex(JSON.stringify(sourceObject));
  const cached = await withCache(request, `analysis-v40/${sourceHash}`, async () => {
    const system = [
      'Tworzysz komentarz analityczny do ligi Turniej F1 2026 po News Engine 3.0.',
      'Nie dodawaj żadnych nowych faktów, nazw, liczb ani przewidywań nieobecnych w danych wejściowych.',
      'Sekcja SCENARIUSZE zawiera deterministyczne wyliczenia backendu. Możesz je wyjaśnić, ale nie rozszerzaj ich o niewyliczone kombinacje.',
      'Jeżeli scenariusz mówi tieBreakerIncluded=false, nie twierdź, że rozstrzyga remis punktowy.',
      'Wyraźnie oddzielaj fakt/wyliczenie od interpretacji. Nie przedstawiaj prognozy jako faktu.',
      'Analiza ma być krótka, konkretna, sportowa i profesjonalna.',
      'Zwróć WYŁĄCZNIE JSON bez markdownu.',
      'Format: {"headline":"...","summary":"...","bullets":["...","...","..."],"titleFight":"...","momentum":"...","constructors":"..."}.',
      'headline max 90, summary max 260, każde bullet/titleFight/momentum/constructors max 180 znaków.',
    ].join('\n');
    const scenarioLines=scenarios.map((x:any)=>{
      if(x.type==='TITLE_CLINCH_THRESHOLD')return `${x.type}: ${x.text} | gap=${x.currentGap} | requiredGapAfterNext=${x.requiredGapAfterNext} | neededGainNextRace=${x.neededGainNextRace} | remainingAfterNext=${x.remainingAfterNext} | tieBreakerIncluded=${x.tieBreakerIncluded}`;
      return `${x.type}: ${x.text} | gap=${x.currentGap} | neededSwing=${x.neededSwing} | max=${x.maxSingleRaceSwing} | mathematicallyAlive=${x.mathematicallyAlive} | tieBreakerIncluded=${x.tieBreakerIncluded}`;
    }).join(' || ');
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
      `SCENARIUSZE BACKENDU: ${scenarioLines || 'brak'}`,
      'Napisz zwięzły komentarz analityczny oparty tylko na tych danych i wyliczeniach.',
    ].join('\n');

    const parsed = await runStructured(
      env,
      ANALYSIS_MODEL,
      [
        { role: 'system', content: system },
        { role: 'user', content: user + '\nZakończ odpowiedź wywołaniem narzędzia submitAnalysis.' },
      ],
      'submitAnalysis',
      'Zwróć komentarz analityczny oparty wyłącznie na danych sezonu i deterministycznych scenariuszach News Engine 3.0.',
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
      900,
    );
    const headline = clean(parsed?.headline, 90);
    const summary = clean(parsed?.summary, 260);
    const bullets = stringArray(parsed?.bullets, 3, 180);
    const titleFight = clean(parsed?.titleFight, 180);
    const momentum = clean(parsed?.momentum, 180);
    const constructors = clean(parsed?.constructors, 180);
    if (!headline || !summary || bullets.length < 2 || !titleFight || !momentum || !constructors) throw new Error('AI zwróciło niepełną analizę.');
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
        label: 'AI ANALIZA • NEWS ENGINE 3.0',
        factsVerifiedBy: 'Dane ligi + deterministyczne scenariusze + News Engine 3.0 / Truth Guard contract',
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
        mediaPromptRevision: MEDIA_PROMPT_REVISION,
        mediaGuidance: MEDIA_GUIDANCE,
        analysisModel: ANALYSIS_MODEL,
        aiBinding: Boolean(env.AI),
        endpoints: ['/api/test','/api/editorial','/api/media','/api/analysis','/media/news-v40/:hash.jpg','/media/news-v35/:hash.jpg','/media/news/:hash.jpg','/media/track-v1/:key.jpg'],
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
    if (request.method === 'GET' && (url.pathname.startsWith('/media/news-v40/') || url.pathname.startsWith('/media/news-v35/') || url.pathname.startsWith('/media/news/') || url.pathname.startsWith('/media/track-v1/'))) {
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
