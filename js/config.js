// Supabase project credentials.
//
// The anon key is DESIGNED to be public – access is governed by Row Level
// Security policies, not by key secrecy. See supabase/schema.sql.
//
// Replace the placeholders below with the values from your Supabase project:
//   Project Settings → API → Project URL  and  anon public key.

export const SUPABASE_URL = 'https://YOUR_PROJECT.supabase.co';
export const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';

// 8-char slugs give ~4 billion combinations. Good enough for a no-account
// capability URL. Increase for more entropy.
export const SLUG_LENGTH = 8;
export const SLUG_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // no ambiguous chars (0/O/1/l)
