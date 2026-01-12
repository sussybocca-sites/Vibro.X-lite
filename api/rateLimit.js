import { createClient } from '@supabase/supabase-js';

// Initialize Supabase
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_KEY env variables!');
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * Check if the IP is allowed to attempt login
 * @param {string} ip
 * @returns {Promise<boolean>}
 */
export async function checkRateLimit(ip) {
  if (!ip) return false;

  const windowMinutes = 10; // time window
  const maxAttempts = 5;    // max attempts allowed

  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

  try {
    const { data, error } = await supabase
      .from('login_attempts')
      .select('id')
      .eq('ip', ip)
      .gte('created_at', since);

    if (error) {
      console.error('Rate limit fetch error:', error);
      return false; // fail-safe: deny login if Supabase fails
    }

    return (data?.length || 0) < maxAttempts;
  } catch (err) {
    console.error('Rate limit unexpected error:', err);
    return false;
  }
}

/**
 * Log a login attempt for an IP
 * @param {string} ip
 */
export async function logAttempt(ip) {
  if (!ip) return;

  try {
    const { error } = await supabase
      .from('login_attempts')
      .insert({ ip });

    if (error) {
      console.error('Failed to log login attempt:', error);
    }
  } catch (err) {
    console.error('Unexpected error logging attempt:', err);
  }
}
