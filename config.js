// BykatAI settings. Both values are safe to publish: Row Level Security protects the data,
// and the Gemini key lives only in the Supabase Edge Function (never in this file).
window.BYKAT_CONFIG = {
  // Supabase dashboard → Project Settings → API (or the "Connect" button)
  SUPABASE_URL: "",   // e.g. "https://abcdefghijklmnop.supabase.co"
  SUPABASE_KEY: "",   // the publishable key ("sb_publishable_...") or the legacy anon key

  // Show "Continue with Google" on the sign-in screen.
  // Only turn this on after enabling the Google provider in Supabase → Authentication → Sign In / Providers.
  GOOGLE_SIGN_IN: false,
};
