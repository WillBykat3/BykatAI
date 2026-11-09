// BykatAI chat function: the only place the Gemini API key is used.
//
// POST { action: "models" }                        → { models, default }
// POST { conversation_id, model?, web_search?, generate_title? }
//      → Server-Sent Events, each "data: {json}":
//        {type:"text", text} · {type:"sources", sources} · {type:"title", title}
//        {type:"done", message} · {type:"error", error}
//
// The conversation's messages (and their attachments) are read with the caller's
// own token, so Row Level Security decides what the function can see.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const BUCKET = "attachments";
const MAX_HISTORY = 100;                 // messages sent to Gemini per request
const MAX_INLINE_BYTES = 12 * 1024 * 1024; // raw file bytes per request (base64 adds ~33%)
const MAX_TEXT_FILE_CHARS = 200_000;
const MODEL_ID = /^[a-z0-9][a-z0-9.\-]{1,80}$/;
const CONNECT_TIMEOUT_MS = 45_000; // waiting for Gemini to start answering
const IDLE_TIMEOUT_MS = 45_000;    // longest gap allowed between streamed chunks

const SYSTEM_PROMPT = `You are BykatAI, a helpful, knowledgeable and friendly AI assistant.
Answer clearly and accurately. Use Markdown for structure when it helps (headings, lists, tables, code blocks with a language tag).
Keep answers as short as the question allows. If you are not sure about something, say so rather than guessing.
When the user shares files or images, look at them carefully and refer to them specifically.`;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

function projectKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}");
    if (keys.default) return keys.default;
  } catch { /* fall back to the legacy key */ }
  return Deno.env.get("SUPABASE_ANON_KEY")!;
}

// ───────────── Models ─────────────
type GeminiModel = { name: string; displayName?: string; description?: string; supportedGenerationMethods?: string[] };
type ModelInfo = { id: string; name: string; description: string };

const NON_CHAT = /(tts|image|imagen|live|embedding|embed|audio|transcribe|robotics|computer-use|aqa|learnlm|veo|lyria|gemma)/;
let modelCache: { at: number; models: ModelInfo[]; fallback: string } | null = null;

function version(id: string): number {
  const m = id.match(/gemini-(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

// Ranks a model for "best everyday default": stable over preview, flash over pro/lite, newest first.
function rank(id: string): number {
  let score = version(id) * 100;
  if (/preview|exp/.test(id)) score -= 1000;
  if (/flash/.test(id) && !/lite/.test(id)) score += 50;
  else if (/pro/.test(id)) score += 20;
  if (/latest/.test(id)) score -= 5;
  return score;
}

async function listModels(apiKey: string) {
  if (modelCache && Date.now() - modelCache.at < 10 * 60_000) return modelCache;
  const found: GeminiModel[] = [];
  let pageToken = "";
  do {
    const url = `${GEMINI_BASE}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const res = await fetch(url, { headers: { "x-goog-api-key": apiKey } });
    if (!res.ok) throw new Error(await geminiError(res));
    const data = await res.json();
    found.push(...(data.models ?? []));
    pageToken = data.nextPageToken ?? "";
  } while (pageToken);

  const models = found
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => ({ id: m.name.replace(/^models\//, ""), name: m.displayName || m.name, description: m.description || "" }))
    .filter((m) => m.id.startsWith("gemini-") && !NON_CHAT.test(m.id))
    .sort((a, b) => rank(b.id) - rank(a.id));

  if (!models.length) throw new Error("Your Gemini API key has no chat models available.");
  modelCache = { at: Date.now(), models, fallback: models[0].id };
  return modelCache;
}

async function defaultModel(apiKey: string): Promise<string> {
  const configured = Deno.env.get("GEMINI_MODEL");
  if (configured) return configured;
  return (await listModels(apiKey)).fallback;
}

async function geminiError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const msg = JSON.parse(text)?.error?.message;
    if (msg) return `Gemini error (${res.status}): ${msg}`;
  } catch { /* not JSON */ }
  return `Gemini error (${res.status}): ${text.slice(0, 300) || res.statusText}`;
}

// ───────────── History → Gemini contents ─────────────
type Attachment = { path: string; name: string; mime_type: string; size: number };
type Row = { role: "user" | "model"; content: string; attachments: Attachment[] | null };
type Part = { text: string } | { inline_data: { mime_type: string; data: string } };

const INLINE_MIME = /^(image\/|application\/pdf$|audio\/|video\/)/;

async function buildContents(sb: SupabaseClient, rows: Row[]) {
  let budget = MAX_INLINE_BYTES;
  const contents: { role: string; parts: Part[] }[] = new Array(rows.length);

  // Walk newest → oldest so recent files win the byte budget.
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const parts: Part[] = [];
    for (const file of row.attachments ?? []) {
      if (file.size > budget) {
        parts.push({ text: `[Attachment "${file.name}" omitted: request size limit reached]` });
        continue;
      }
      const { data, error } = await sb.storage.from(BUCKET).download(file.path);
      if (error || !data) {
        parts.push({ text: `[Attachment "${file.name}" could not be loaded]` });
        continue;
      }
      const bytes = new Uint8Array(await data.arrayBuffer());
      budget -= bytes.byteLength;
      if (INLINE_MIME.test(file.mime_type)) {
        parts.push({ inline_data: { mime_type: file.mime_type, data: encodeBase64(bytes) } });
      } else {
        let text = new TextDecoder().decode(bytes);
        if (text.length > MAX_TEXT_FILE_CHARS) text = text.slice(0, MAX_TEXT_FILE_CHARS) + "\n…[truncated]";
        parts.push({ text: `File: ${file.name}\n\`\`\`\n${text}\n\`\`\`` });
      }
    }
    if (row.content) parts.push({ text: row.content });
    if (!parts.length) parts.push({ text: "(empty message)" });
    contents[i] = { role: row.role, parts };
  }
  // Gemini expects turns to alternate; merge back-to-back messages from the same side.
  const merged: typeof contents = [];
  for (const c of contents) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === c.role) prev.parts.push(...c.parts);
    else merged.push(c);
  }
  return merged;
}

// ───────────── Title ─────────────
async function makeTitle(apiKey: string, model: string, question: string, answer: string): Promise<string | null> {
  const res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [{
          text: `Write a short title (2 to 6 words) for a chat that starts like this. Reply with the title only: no quotes, no trailing punctuation.\n\nUser: ${question.slice(0, 1500)}\n\nAssistant: ${answer.slice(0, 1500)}`,
        }],
      }],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const text: string = (data?.candidates?.[0]?.content?.parts ?? [])
    .filter((p: { thought?: boolean }) => !p.thought)
    .map((p: { text?: string }) => p.text ?? "")
    .join("")
    .trim()
    .replace(/^["'#*\s]+|["'.*\s]+$/g, "");
  return text ? text.slice(0, 80) : null;
}

// ───────────── Handler ─────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const t0 = Date.now();
  const log = (stage: string, extra: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ stage, ms: Date.now() - t0, ...extra }));
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!token) return json({ error: "Not signed in" }, 401);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, projectKey(), {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await sb.auth.getUser(token);
  if (userError || !userData.user) return json({ error: "Your session has expired. Please sign in again." }, 401);
  const userId = userData.user.id;

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    return json({ error: "The Gemini API key isn't set up yet. Add a GEMINI_API_KEY secret to the Supabase Edge Function." }, 500);
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }

  if (body.action === "models") {
    try {
      const { models } = await listModels(apiKey);
      return json({ models, default: await defaultModel(apiKey) });
    } catch (e) {
      return json({ error: (e as Error).message }, 502);
    }
  }

  const conversationId = String(body.conversation_id ?? "");
  if (!conversationId) return json({ error: "conversation_id is required" }, 400);

  let model: string;
  try {
    model = typeof body.model === "string" && MODEL_ID.test(body.model) ? body.model : await defaultModel(apiKey);
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }

  const { data: convo, error: convoError } = await sb
    .from("conversations").select("id").eq("id", conversationId).maybeSingle();
  if (convoError) return json({ error: convoError.message }, 500);
  if (!convo) return json({ error: "Conversation not found" }, 404);

  const { data: rows, error: rowsError } = await sb
    .from("messages")
    .select("role, content, attachments")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(MAX_HISTORY);
  if (rowsError) return json({ error: rowsError.message }, 500);
  const history = (rows as Row[]).reverse();
  if (!history.length || history[history.length - 1].role !== "user") {
    return json({ error: "The last message must be from the user" }, 400);
  }

  log("history loaded", { messages: history.length, model });
  const contents = await buildContents(sb, history);
  const request: Record<string, unknown> = {
    contents,
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
  };
  if (body.web_search === true) request.tools = [{ google_search: {} }];

  // One controller covers both the wait for Gemini's first byte and any stall mid-stream.
  const abort = new AbortController();
  let timer = setTimeout(() => abort.abort(new Error("connect timeout")), CONNECT_TIMEOUT_MS);
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => abort.abort(new Error("idle timeout")), IDLE_TIMEOUT_MS);
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${GEMINI_BASE}/models/${model}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: abort.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    log("gemini fetch failed", { error: String(e) });
    return json({ error: abort.signal.aborted ? `Gemini (${model}) didn't respond in time. Try again, or pick another model.` : `Couldn't reach Gemini: ${(e as Error).message}` }, 504);
  }
  log("gemini responded", { status: upstream.status });
  if (!upstream.ok || !upstream.body) {
    clearTimeout(timer);
    return json({ error: await geminiError(upstream) }, 502);
  }
  touch();

  let answer = "";
  const sources = new Map<string, string>();
  let saved = false;
  let clientGone = false;

  const save = async () => {
    if (saved) return null;
    saved = true;
    if (!answer.trim()) return null;
    const { data, error } = await sb
      .from("messages")
      .insert({ conversation_id: conversationId, user_id: userId, role: "model", content: answer })
      .select("id, created_at")
      .single();
    if (error) throw new Error(`Could not save the reply: ${error.message}`);
    await sb.from("conversations").update({ model }).eq("id", conversationId);
    log("saved", { chars: answer.length });
    return data;
  };

  // Events go out as Server-Sent Events ("data: {json}\n\n"), which proxies pass through unbuffered.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  // Writes are queued rather than awaited, so a slow connection can't stall reading from Gemini.
  const send = (event: unknown) => {
    if (clientGone) return;
    writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)).catch(() => {
      if (!clientGone) log("client disconnected");
      clientGone = true; // the user pressed stop or closed the tab
    });
  };

  const pump = (async () => {
    const reader = upstream.body!.getReader();
    // Belt and braces: on timeout, also cancel the read directly so the loop below can't hang.
    abort.signal.addEventListener("abort", () => { reader.cancel().catch(() => {}); });
    const decoder = new TextDecoder();
    let buffer = "";
    let blocked = "";
    let chunks = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        touch();
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          let chunk;
          try { chunk = JSON.parse(line.slice(5)); } catch { continue; }
          if (chunks++ === 0) log("first chunk");
          if (chunk.error) throw new Error(chunk.error.message ?? "Gemini returned an error");
          if (chunk.promptFeedback?.blockReason) blocked = chunk.promptFeedback.blockReason;
          const cand = chunk.candidates?.[0];
          for (const part of cand?.content?.parts ?? []) {
            if (part.thought || typeof part.text !== "string") continue;
            answer += part.text;
            send({ type: "text", text: part.text });
          }
          for (const g of cand?.groundingMetadata?.groundingChunks ?? []) {
            if (g.web?.uri) sources.set(g.web.uri, g.web.title || g.web.uri);
          }
          if (cand?.finishReason && !["STOP", "MAX_TOKENS", "FINISH_REASON_UNSPECIFIED"].includes(cand.finishReason) && !answer) {
            blocked = cand.finishReason;
          }
        }
        if (clientGone) { await reader.cancel().catch(() => {}); break; }
      }
      clearTimeout(timer);
      if (abort.signal.aborted) throw new Error(String(abort.signal.reason));
      log("gemini finished", { chunks, chars: answer.length, blocked });

      if (!answer && blocked) throw new Error(`Gemini didn't answer (reason: ${blocked}). Try rephrasing.`);
      if (!answer && !clientGone) throw new Error("Gemini returned an empty reply. Try again.");
      if (sources.size) send({ type: "sources", sources: [...sources].map(([url, title]) => ({ url, title })) });

      const message = await save();
      if (body.generate_title === true && answer && !clientGone) {
        const question = history[history.length - 1].content || "(attachment)";
        const title = await makeTitle(apiKey, model, question, answer).catch(() => null);
        if (title) {
          await sb.from("conversations").update({ title }).eq("id", conversationId);
          send({ type: "title", title });
        }
      }
      send({ type: "done", model, message });
    } catch (e) {
      clearTimeout(timer);
      const msg = abort.signal.aborted
        ? `Gemini (${model}) stopped responding. Try again, or pick another model.`
        : (e as Error).message;
      log("stream error", { error: String(e) });
      await save().catch(() => null);
      send({ type: "error", error: msg });
    } finally {
      await writer.close().catch(() => {});
      log("closed");
    }
  })();
  // Keep the worker alive until the reply is saved, even if the browser disconnects.
  (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime?.waitUntil(pump);

  return new Response(readable, {
    headers: { ...cors, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
  });
});
