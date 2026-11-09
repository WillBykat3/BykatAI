# BykatAI

A sleek AI chat app powered by Google Gemini, with user accounts, saved chat history and file uploads, all running on Supabase.

- **Accounts**: email and password sign-up, sign-in, password reset (optional Google sign-in)
- **Chat history**: every conversation is saved per user; you can search, rename and delete chats
- **File uploads**: images, PDFs, audio, video, text and code files (paperclip, drag and drop, or paste). Up to 10 files, 10 MB each
- **Streaming replies** rendered as Markdown, with syntax-highlighted code blocks and copy buttons
- **Model picker**: lists the Gemini models your API key can use. "BykatAI Auto" picks the best stable one
- **Web search** toggle (Gemini's Google Search grounding), with source links under the answer
- Light and dark mode, and works on desktop and phones

It's a static site (`index.html`, `styles.css`, `app.js`) plus one Supabase Edge Function (`supabase/functions/chat`). **Your Gemini API key only ever lives in Supabase**: it's never sent to the browser.

```
index.html, styles.css, app.js   the web app
config.js                        your Supabase URL + publishable key (safe to commit)
vendor/                          bundled libraries (supabase-js, marked, DOMPurify, highlight.js)
supabase/migrations/…sql         database tables, security rules and the file bucket
supabase/functions/chat/         the Gemini proxy (streams replies, reads attachments, saves messages)
```

## Setup

### 1. Create the database

1. In the [Supabase dashboard](https://supabase.com/dashboard), open your project (or create one).
2. Go to **SQL Editor**, paste in the contents of `supabase/migrations/20261109000000_bykatai_init.sql`, and click **Run**.

This creates the `conversations` and `messages` tables, the Row Level Security rules that keep each user's data private, and a private `attachments` storage bucket.

### 2. Deploy the chat function

With the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started):

```sh
supabase login
supabase link --project-ref <your-project-ref>
supabase functions deploy chat --no-verify-jwt
```

`--no-verify-jwt` is intentional: the function checks the signed-in user itself, which works with both the new publishable keys and the legacy anon key. (`supabase/config.toml` sets the same thing.)

### 3. Add your Gemini API key

1. Get a key from [Google AI Studio](https://aistudio.google.com/) (**Get API key**).
2. In Supabase go to **Edge Functions → Secrets** and add `GEMINI_API_KEY` with your key. Or use the CLI:

   ```sh
   supabase secrets set GEMINI_API_KEY=your-key-here
   ```

Optional: add a `GEMINI_MODEL` secret (for example a specific model ID) to pin the default model. Without it, the function picks the newest stable Flash model your key can use.

### 4. Point the website at Supabase

Edit `config.js`:

```js
SUPABASE_URL: "https://<your-project-ref>.supabase.co",
SUPABASE_KEY: "sb_publishable_...",   // Project Settings → API Keys (or the legacy anon key)
```

Both values are meant to be public. Your data is protected by Row Level Security.

### 5. Set the sign-in redirect URLs

In **Authentication → URL Configuration**, set the **Site URL** to wherever you host BykatAI (for example `https://<you>.github.io/BykatAI/`) and add it under **Redirect URLs**. Also add `http://localhost:8000/` if you test locally. Email confirmation and password-reset links send people back here.

### 6. Host it

Any static host works: GitHub Pages (Settings → Pages → deploy from branch), Netlify, Vercel or Cloudflare Pages. No build step.

To try it locally:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Optional: Google sign-in

Enable the Google provider in **Authentication → Sign In / Providers** (it needs a Google OAuth client), then set `GOOGLE_SIGN_IN: true` in `config.js`.

## Notes

- Supported uploads: PNG, JPEG, WebP, HEIC/HEIF, PDF, common audio and video formats, and text/code files (`.txt`, `.md`, `.csv`, `.json`, `.py`, `.js`, `.ts`, `.html`, `.sql` and many more). Word, Excel and GIF files aren't supported by Gemini's inline upload, so they're rejected with a message.
- Each request sends up to the last 100 messages and up to 12 MB of attachments to Gemini (newest files first). Older files beyond that are noted but left out.
- Deleting a chat (or "Delete all chats" in Settings) also deletes its uploaded files.
- Supabase's built-in email service is rate-limited and meant for testing. For real users, set up custom SMTP in **Authentication → Emails**.
