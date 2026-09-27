// Netlify serverless proxy for SauceNAO reverse image search.
// The API key is read from the SAUCENAO_KEY environment variable
// (Netlify → Site settings → Environment variables) and never reaches the browser.

const toTag = (phrase) => String(phrase)
  .replace(/\(.*?\)/g, " ")               // drop "(series)" suffixes inside character names
  .replace(/[^a-zA-Z0-9]+/g, " ")
  .trim().split(/\s+/).filter(Boolean)
  .map(w => w.charAt(0).toUpperCase() + w.slice(1))
  .join("");

const MIN_SIM = 50;   // ignore weak matches to avoid wrong tags

exports.handler = async (event) => {
  const J = (code, obj) => ({
    statusCode: code,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(obj),
  });

  // health-метка: открой URL функции в браузере (GET) — увидишь версию залитого кода
  if (event.httpMethod !== "POST")
    return J(200, { ok: true, version: "sauce-v2", usage: "POST {imageBase64, mime}" });

  const KEY = process.env.SAUCENAO_KEY;
  if (!KEY) return J(500, { ok: false, error: "SAUCENAO_KEY не задан в настройках Netlify" });

  let imageBase64, mime;
  try { ({ imageBase64, mime } = JSON.parse(event.body || "{}")); }
  catch { return J(400, { ok: false, error: "плохой запрос" }); }
  if (!imageBase64) return J(400, { ok: false, error: "нет изображения" });

  try {
    const buf = Buffer.from(imageBase64, "base64");
    const form = new FormData();
    form.append("file", new Blob([buf], { type: mime || "image/jpeg" }), "image.jpg");

    const url = `https://saucenao.com/search.php?output_type=2&db=999&numres=12&api_key=${encodeURIComponent(KEY)}`;
    const r = await fetch(url, { method: "POST", body: form });
    if (r.status === 429) return J(200, { ok: false, error: "лимит SauceNAO — слишком часто, подожди ~30 секунд" });

    const textBody = await r.text();
    let data;
    try { data = JSON.parse(textBody); }
    catch { return J(200, { ok: false, error: "SauceNAO вернул не-JSON (вероятно, лимит запросов) — подожди и повтори" }); }

    const remaining = data && data.header ? data.header.long_remaining : null;
    const results = (data && Array.isArray(data.results)) ? data.results : [];
    results.sort((a, b) =>
      parseFloat((b.header && b.header.similarity) || 0) -
      parseFloat((a.header && a.header.similarity) || 0));

    const siteName = (idx) => String(idx || "").replace(/^Index #\d+:\s*/, "").split(" - ")[0].trim() || "источник";

    const tags = [];
    const push = (t) => { if (t && !tags.includes(t)) tags.push(t); };
    let best = null;
    const sources = [];   // вероятные источники даже без тегов — для ручной проверки

    for (const res of results) {
      const sim = parseFloat((res.header && res.header.similarity) || 0);
      const d = res.data || {};
      const link = (d.ext_urls && d.ext_urls[0]) || null;

      if (link && sim >= 40 && sources.length < 3 && !sources.some(s => s.url === link))
        sources.push({ url: link, similarity: sim, site: siteName(res.header && res.header.index_name) });

      if (sim < MIN_SIM) continue;
      const chars  = d.characters ? String(d.characters).split(",").map(s => s.trim()).filter(Boolean) : [];
      const series = d.material   ? String(d.material).split(",").map(s => s.trim()).filter(Boolean)   : [];
      if (!chars.length && !series.length) continue;

      if (!best) best = {
        similarity: sim,
        label: [chars[0], series[0]].filter(Boolean).join(" · ") || "совпадение",
        source: link,
      };
      chars.forEach(c => push(toTag(c)));
      series.forEach(s => push(toTag(s)));
    }

    return J(200, { ok: true, tags: tags.slice(0, 10), best, sources, remaining });
  } catch (e) {
    return J(502, { ok: false, error: "SauceNAO: " + (e.message || "ошибка") });
  }
};
