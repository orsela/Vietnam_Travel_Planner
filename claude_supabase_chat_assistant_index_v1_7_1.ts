// Supabase Edge Function: chat-assistant
// -----------------------------------------------------------------------------
// Purpose: proxy between the Vietnam Travel Planner app (a single static HTML
// file with no server of its own) and the Claude API, so the family's Claude
// API key never has to be embedded in client-side code where anyone who opens
// the file could read it. The app sends a question + trip context here; this
// function attaches the API key (kept as a Supabase secret, never sent to the
// browser) and calls Claude on the app's behalf.
//
// Deploy once per SUPABASE_SETUP_v1.5.7.txt. You do not need to understand
// this file to use it -- just deploy it and set the secret as instructed.
// -----------------------------------------------------------------------------

// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = "claude-haiku-4-5-20251001"; // fast + inexpensive, plenty for this use case

/* CHANGE 2026-08-28 GM-20: two-provider routing (Claude / Gemini) by question topic, per
   family decision: Gemini answers maps/navigation and photo questions, Claude answers everything
   about the trip itinerary itself. Routing is pure keyword matching on the question text -- no
   extra classification call, no added latency/cost for the common case. Gemini here is TEXT-ONLY:
   it does not receive or analyze any actual photos from the album, only answers general
   map/navigation/photography questions in words. If GEMINI_API_KEY isn't set, or the Gemini call
   fails for any reason, requests fall back to Claude automatically so the chat never just breaks --
   this fallback is a reliability safety net only, not a change to which provider normally answers
   which topic. See CHANGELOG_v1.5.10.txt. */
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const GEMINI_MODEL = "gemini-2.5-flash";

const MAP_KEYWORDS = ["מפה", "מפות", "ניווט", "לנווט", "וויז", "waze", "google maps", "גוגל מפות", "כיוונים", "איך מגיעים", "איך להגיע", "מרחק בין", "מרחק מ", "נסיעה מ", "כמה זמן נסיעה"];
const PHOTO_KEYWORDS = ["תמונה", "תמונות", "תמונת", "צילום", "לצלם", "מצלמה", "אלבום", "סלפי", "selfie", "פילטר", "עריכת תמונ"];

function classifyProvider(question: string): "gemini" | "claude" {
  const q = String(question || "").toLowerCase();
  if (MAP_KEYWORDS.some((k) => q.includes(k)) || PHOTO_KEYWORDS.some((k) => q.includes(k))) {
    return "gemini";
  }
  return "claude";
}

// Allow the app to call this from any origin (it's a static file that may be
// opened as file://, or hosted anywhere) -- there's no user login/session to
// protect here, just an anon-key-gated proxy in front of a paid API, which is
// why CHAT_RATE_LIMIT below exists.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Simple per-invocation-instance rate limit as a cost guardrail -- Edge
// Function instances are short-lived and this resets often, so it's a coarse
// safety net, not a precise limiter. The real guardrail is the monthly spend
// cap you set on console.anthropic.com (see the setup guide).
const seen = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 15;

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const timestamps = (seen.get(key) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  seen.set(key, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
}

function buildSystemPrompt(): string {
  return [
    "אתה עוזר משפחתי ידידותי שעונה בעברית על שאלות לגבי טיול משפחתי מתוכנן בוייטנאם.",
    "יש לך גישה למידע על כל ימי המסלול (תאריך, אזור, כותרת) ולפרטים מלאים על היום שבו המשתמש נמצא כרגע באפליקציה, כולל סטטוס הזמנה (הוזמן/לא, מספר אישור, עלות בפועל).",
    "אם בבקשה סופקו לך שערי המרה נוכחיים (fx) ו/או תחזית מזג אוויר ליום הנוכחי (weather) -- התייחס אליהם כמידע אמין ועדכני, ואפשר להשתמש בהם ישירות כדי לענות על שאלות המרה או שאלות על מזג האוויר הצפוי לאותו יום.",
    "יש לך גישה לשלושה כלים (add_waypoint, add_expense, swap_days) להצעת שינוי במסלול. השתמש בהם רק כשהמשתמש מבקש זאת במפורש ובאופן חד-משמעי (למשל \"תוסיף נקודת עניין X ליום Y\", \"תחליף בין יום X ליום Y\") -- לעולם לא כתגובה לשאלת מידע/המלצה כללית, גם אם היא נשמעת קרובה. הכלי רק מציע פעולה -- המשתמש עדיין צריך לאשר אותה בפועל, אז תמיד צרף גם משפט טקסט קצר שמסביר מה אתה מציע. לגבי add_expense במיוחד: חובה שיהיו בידך שלושתם -- תיאור, סכום, וקטגוריה -- לפני שאתה קורא לכלי. אם המשתמש נתן רק חלק מהם (למשל רק סכום, בלי תיאור או קטגוריה), אל תנחש ואל תשתמש בברירת מחדל -- שאל אותו בטקסט רגיל מה חסר, ורק כשיש את כל השלושה להציע את הפעולה.",
    "ענה בקצרה ובאופן פרקטי ומועיל, בעברית בלבד, ללא שימוש במידע שלא נמסר לך -- אם משהו לא ידוע לך מהנתונים שסופקו בבקשה הזו (כולל אם fx או weather לא נכללו בה), אמור זאת בבירור במקום להמציא פרטים (למשל שעות פתיחה מדויקות, מחירים עדכניים שלא סופקו, או תנאי מזג אוויר שלא סופקו).",
    "אתה יכול להשתמש בידע כללי שלך על ויאטנם (תרבות, טיפים לתיירים, המלצות כלליות) כל עוד אתה לא סותר את נתוני המסלול שסופקו.",
    "התשובה צריכה להיות קצרה -- בדרך כלל 2-4 משפטים, אלא אם נשאלת שאלה שדורשת פירוט רב יותר.",
  ].join(" ");
}

/* CHANGE 2026-08-29 GM-21: agentic actions -- Claude can now PROPOSE (never silently execute)
   one of three structured actions per family decision: (1) confirmation card before every
   action, (2) any registered user may approve it -- same permission model the app already uses
   for edits/deletes, (3) starting scope is add_waypoint / update_day_cost / swap_days. This
   function NEVER writes to Supabase and NEVER mutates trip data -- it only returns a proposed
   action as structured JSON; the actual mutation happens client-side, using the app's own
   existing waypoint/budget/day functions, only after the user taps "אישור" on the confirmation
   card. This keeps a human in the loop for every change to the shared family itinerary, and
   keeps the server from ever needing write access to Supabase. Gemini (maps/photo questions)
   intentionally does NOT get tools -- actions are only in Claude's itinerary/budget domain.
   See CHANGELOG_v1.7.0.txt. */
const TOOLS = [
  {
    name: "add_waypoint",
    description: "הצעה להוסיף נקודת עניין (מקום ספציפי) ליום מסוים במסלול. להשתמש רק כשהמשתמש מבקש זאת במפורש -- לא כתגובה לשאלת מידע כללית.",
    input_schema: {
      type: "object",
      properties: {
        day: { type: "integer", description: "מספר היום (day) במסלול אליו יש להוסיף את נקודת העניין" },
        name: { type: "string", description: "שם המקום שיש להוסיף" },
        notes: { type: "string", description: "הערה קצרה אופציונלית על המקום" },
      },
      required: ["day", "name"],
    },
  },
  {
    name: "add_expense",
    description: "הצעה להוסיף הוצאה לרשימת ההוצאות המשותפת של הטיול. חובה לכלול תיאור, סכום וקטגוריה -- שלושתם יחד, בלי לנחש אף אחד מהם. אם המשתמש לא ציין אחד מהשלושה במפורש, אין להשתמש בכלי -- יש לשאול אותו בטקסט רגיל מה חסר, ורק בפעם הבאה שיש את כל השלושה להציע את הפעולה.",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string", description: "תיאור קצר של ההוצאה (למשל 'ארוחת ערב בהוי אן')" },
        amount: { type: "number", description: "הסכום בשקלים" },
        category: {
          type: "string",
          description: "קטגוריית ההוצאה",
          enum: ["lodging", "food", "markets", "shopping", "attractions", "other"],
        },
      },
      required: ["description", "amount", "category"],
    },
  },
  {
    name: "swap_days",
    description: "הצעה להחליף בין התוכן (אזור, כותרת, פעילויות, מלון, נקודות עניין וכו') של שני ימים במסלול. מספרי הימים והתאריכים עצמם נשארים במקומם -- רק התוכן מוחלף. להשתמש רק כשהמשתמש מבקש במפורש להחליף/לסדר מחדש ימים.",
    input_schema: {
      type: "object",
      properties: {
        day_a: { type: "integer", description: "מספר היום הראשון להחלפה" },
        day_b: { type: "integer", description: "מספר היום השני להחלפה" },
      },
      required: ["day_a", "day_b"],
    },
  },
];

const CATEGORY_LABELS_HE: Record<string, string> = {
  lodging: "לינה", food: "אוכל", markets: "שווקים", shopping: "קניות", attractions: "אטרקציות", other: "אחר",
};

function describeAction(name: string, input: any): string {
  switch (name) {
    case "add_waypoint":
      return `להוסיף נקודת עניין "${input?.name ?? ""}" ליום ${input?.day ?? "?"}${input?.notes ? ` (${input.notes})` : ""}?`;
    case "add_expense":
      return `להוסיף הוצאה: "${input?.description ?? ""}" בסך ${input?.amount ?? "?"} ש"ח, קטגוריה: ${CATEGORY_LABELS_HE[input?.category] ?? input?.category ?? "אחר"}?`;
    case "swap_days":
      return `להחליף את תוכן יום ${input?.day_a ?? "?"} עם תוכן יום ${input?.day_b ?? "?"}?`;
    default:
      return "לבצע את הפעולה המוצעת?";
  }
}

function buildGeminiSystemPrompt(): string {
  return [
    "אתה עוזר לוגיסטי לטיול משפחתי בוייטנאם, בעברית בלבד.",
    "התחום שלך מצומצם בכוונה לשני נושאים: (1) שאלות ניווט/מפות/מרחקים/זמני נסיעה בין נקודות במסלול, (2) טיפים כלליים לצילום תמונות בטיול (זוויות, תאורה, מה כדאי לצלם באזור).",
    "חשוב: אין לך גישה בפועל לתמונות באלבום של המשפחה, ואין לך גישה בזמן אמת ל-Google Maps/Waze -- אתה יכול לתת הערכות כלליות מהידע שלך ומהקואורדינטות/שמות המקומות שסופקו לך, אבל לא נתוני תנועה/זמן נסיעה מדויקים בזמן אמת. אם נשאלת על כך, אמור זאת בבירור והפנה לאפליקציית ניווט אמיתית לזמן מדויק.",
    "אם נשאלת שאלה שאינה בתחום שלך (על פעילויות הטיול, תקציב, הזמנות וכו') -- ענה בקצרה שזו שאלה שכדאי לשאול דרך הצ'אט הרגיל של המסלול, בלי לנסות לענות עליה בעצמך.",
    "התשובה קצרה ופרקטית -- בדרך כלל 2-4 משפטים.",
  ].join(" ");
}

async function callGemini(userContent: string, history: any[]): Promise<string | null> {
  if (!GEMINI_API_KEY) return null;
  const contents = [
    ...history
      .filter((m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.text === "string")
      .map((m: any) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.text }] })),
    { role: "user", parts: [{ text: userContent }] },
  ];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: buildGeminiSystemPrompt() }] },
          contents,
          generationConfig: { maxOutputTokens: 400 },
        }),
        signal: controller.signal,
      },
    ).finally(() => clearTimeout(timer));
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("Gemini API error", res.status, errText);
      return null;
    }
    const data = await res.json();
    const answer = (data?.candidates?.[0]?.content?.parts || [])
      .map((p: any) => p?.text || "")
      .join("\n")
      .trim();
    return answer || null;
  } catch (e) {
    console.error("Gemini call failed", e);
    return null;
  }
}

function buildUserContent(body: any): string {
  const parts: string[] = [];
  if (Array.isArray(body.trip) && body.trip.length) {
    parts.push("סקירת המסלול המלא (יום, תאריך, אזור, כותרת):");
    parts.push(JSON.stringify(body.trip));
  }
  if (body.currentDay) {
    parts.push("היום שהמשתמש צופה בו כרגע באפליקציה (כולל סטטוס הזמנה אם קיים):");
    parts.push(JSON.stringify(body.currentDay));
  }
  if (body.fx && typeof body.fx === "object") {
    parts.push('שערי המרה נוכחיים ששמורים באפליקציה (כמה ש"ח שווה 1 יחידה של כל מטבע; VND הוא לרוב ל-1000 יחידות):');
    parts.push(JSON.stringify(body.fx));
  }
  if (body.weather && typeof body.weather === "object") {
    parts.push("תחזית מזג אוויר לאזור וליום שהמשתמש צופה בו כרגע:");
    parts.push(JSON.stringify(body.weather));
  }
  parts.push("שאלת המשתמש:");
  parts.push(String(body.question || ""));
  return parts.join("\n\n");
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  if (!ANTHROPIC_API_KEY && !GEMINI_API_KEY) {
    return new Response(JSON.stringify({ error: "no API key configured (ANTHROPIC_API_KEY / GEMINI_API_KEY)" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  const clientKey = req.headers.get("x-forwarded-for") || "anonymous";
  if (isRateLimited(clientKey)) {
    return new Response(JSON.stringify({ error: "rate limited, try again in a minute" }), {
      status: 429,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  if (!body.question || typeof body.question !== "string") {
    return new Response(JSON.stringify({ error: "missing question" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
  const userContent = buildUserContent(body);

  const provider = classifyProvider(body.question);
  if (provider === "gemini") {
    const geminiAnswer = await callGemini(userContent, history);
    if (geminiAnswer) {
      return new Response(JSON.stringify({ answer: geminiAnswer, provider: "gemini" }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    // Gemini unset/failed -- fall through to Claude below as a reliability net.
  }

  if (!ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const messages = [
    ...history
      .filter((m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.text === "string")
      .map((m: any) => ({ role: m.role, content: m.text })),
    { role: "user", content: userContent },
  ];

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
        system: buildSystemPrompt(),
        messages,
        tools: TOOLS,
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text().catch(() => "");
      console.error("Anthropic API error", anthropicRes.status, errText);
      return new Response(JSON.stringify({ error: "upstream error" }), {
        status: 502,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const data = await anthropicRes.json();
    const content = data?.content || [];
    const answer = content
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim() || "לא הצלחתי למצוא תשובה כרגע.";

    const toolUse = content.find((b: any) => b?.type === "tool_use");
    const action = toolUse
      ? { type: toolUse.name, params: toolUse.input, description: describeAction(toolUse.name, toolUse.input) }
      : null;

    return new Response(JSON.stringify({ answer, action, provider: "claude" }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("chat-assistant error", e);
    return new Response(JSON.stringify({ error: "internal error" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
