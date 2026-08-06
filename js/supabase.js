// Supabase client (single shared instance) plus small realtime helpers.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
  realtime: { params: { eventsPerSecond: 10 } },
});

/**
 * Subscribe to all realtime changes on a board's tables.
 * @param {string} boardId
 * @param {(payload: object)=>void} onChange  receives {event, table, old, new}
 * @returns {() => void} unsubscribe
 */
export function subscribeBoard(boardId, onChange) {
  const filter = `board_id=eq.${boardId}`;

  const cardsChannel = supabase
    .channel(`cards:${boardId}`)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'cards', filter },
      (payload) => onChange({ ...payload, _table: 'cards' }))
    .subscribe();

  const boardsChannel = supabase
    .channel(`board:${boardId}`)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'boards', filter: `id=eq.${boardId}` },
      (payload) => onChange({ ...payload, _table: 'boards' }))
    .subscribe();

  return () => {
    supabase.removeChannel(cardsChannel);
    supabase.removeChannel(boardsChannel);
  };
}
