// Netlify serverless proxy for Google Gemini vision character recognition.
// Set GEMINI_KEY in Netlify → Site settings → Environment variables.
// Optionally GEMINI_MODEL (default: gemini-2.5-flash). Free key: https://aistudio.google.com/apikey

const toTag = (phrase) => String(phrase)
  .replace(/\(.*?\)/g, " ")
  .replace(/[^a-zA-Z0-9]+/g, " ")
  .trim().split(/\s+/).filter(Boolean)
  .map(w => w.charAt(0).toUpperCase() + w.slice(1))
  .join("");

const PROMPT = `You are an expert in anime, manga, and video-game characters. Identify the character(s) depicted in this artwork.
Respond with ONLY a JSON object (no markdown, no commentary) in this exact shape:
{"characters": ["Character Name"], "series": "Series Name", "confidence": "high"}
Rules:
- Use the most widely-used official English names.
- "series" is the franchise/game the character is from (e.g. "Honkai: Star Rail").
- List every distinct main character you recognize in "characters".
- "confidence" is one of "high", "medium", "low".
- If you recognize no one, return {"characters": [], "series": "", "confidence": "low"}.`;

exports.handler = async (event) => {
  const J = (code, obj) => ({
    statusCode: code,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(obj),
  });

  // health-метка: открой URL функции в браузере (GET) — увидишь версию залитого кода
  if (event.httpMethod !== "POST")
    return J(200, { ok: true, version: "gemini-v2", usage: "POST {imageBase64, mime}" });

  const KEY = process.env.GEMINI_KEY;
  if (!KEY) return J(200, { ok: false, error: "Ключ Gemini не задан" });
  const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  let imageBase64, mime;
  try { ({ imageBase64, mime } = JSON.parse(event.body || "{}")); }
  catch { return J(400, { ok: false, error: "плохой запрос" }); }
  if (!imageBase64) return J(400, { ok: false, error: "нет изображения" });

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(KEY)}`;
    const body = {
      contents: [{ parts: [
        { text: PROMPT },
        { inline_data: { mime_type: mime || "image/jpeg", data: imageBase64 } },
      ] }],
      generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
    };
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) return J(200, { ok: false, error: "Gemini: " + ((data.error && data.error.message) || r.status) });

    const txt = (((data.candidates || [])[0] || {}).content || {}).parts;
    const raw = (txt && txt[0] && txt[0].text) || "";
    let parsed = null;
    try { parsed = JSON.parse(raw); }
    catch { const m = raw.match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch {} } }
    if (!parsed) return J(200, { ok: false, error: "Gemini вернул неразборчивый ответ" });

    const chars = Array.isArray(parsed.characters) ? parsed.characters.filter(Boolean) : [];
    const tags = [];
    const push = (t) => { if (t && !tags.includes(t)) tags.push(t); };
    chars.forEach(c => push(toTag(c)));
    if (parsed.series) push(toTag(parsed.series));

    const label = [chars[0], parsed.series].filter(Boolean).join(" · ") || "не распознано";
    return J(200, {
      ok: true,
      engine: "gemini",
      tags: tags.slice(0, 10),
      best: { label, confidence: parsed.confidence || "low" },
    });
  } catch (e) {
    return J(502, { ok: false, error: "Gemini: " + (e.message || "ошибка") });
  }
};
