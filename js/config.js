// Supabase project credentials.
//
// The anon key is DESIGNED to be public – access is governed by Row Level
// Security policies, not by key secrecy. See supabase/schema.sql.

export const SUPABASE_URL = 'https://dwssjyjnafimhjtcqnjz.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_Javq2_yN6vAmuJ2cyCk2DQ_UgEH3h89';

// 8-char slugs give ~4 billion combinations. Good enough for a no-account
// capability URL. Increase for more entropy.
export const SLUG_LENGTH = 8;
export const SLUG_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // no ambiguous chars (0/O/1/l)
