import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { checkRateLimit, logAttempt } from './rateLimit.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Nodemailer transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Verify CAPTCHA
async function verifyCaptcha(token, ip) {
  if (!token) return false;
  const secret = process.env.CAPTCHA_SECRET_KEY;
  const res = await fetch('https://hcaptcha.com/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `secret=${secret}&response=${token}&remoteip=${ip}`
  });
  const data = await res.json();
  return data.success === true;
}

// Device fingerprint hash
function getDeviceFingerprint(headers, frontendFingerprint) {
  const source =
    frontendFingerprint ||
    headers['user-agent'] + headers['accept-language'] + headers['x-forwarded-for'] + uuidv4();
  return crypto.createHash('sha256').update(source).digest('hex');
}

// Random delay (anti-bruteforce)
async function randomDelay() {
  const delay = 500 + Math.random() * 1000;
  return new Promise(res => setTimeout(res, delay));
}

// AES-GCM encrypted session token
function generateEncryptedToken() {
  const iv = crypto.randomBytes(16);
  const key = crypto.scryptSync(process.env.SESSION_SECRET, 'salt', 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const uuid = uuidv4();
  const encrypted = cipher.update(uuid, 'utf8', 'hex') + cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

// Send verification email
async function sendVerificationEmail(email, code) {
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: email,
    subject: 'Verify Your Login',
    text: `Your verification code is: ${code}\nIt expires in 1 minute.`
  });
}

// Generate 6-digit verification code
function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Strong password check
function passwordStrongEnough(password) {
  return (
    password.length >= 8 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /\d/.test(password) &&
    /[!@#$%^&*]/.test(password)
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const ip = req.headers['x-forwarded-for'] || req.headers['client-ip'] || 'unknown';
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

const {
  email,
  password,
  remember_me,
  captcha_token,
  google,
  fingerprint,
  verification_code
} = body;

    // Google login shortcut
    if (google) {
      return res.status(200).json({ success: true, redirect: '/.netlify/functions/googleStart' });
    }

    // Rate limit check
    if (!(await checkRateLimit(ip + email))) {
      return res.status(429).json({ success: false, error: 'Too many login attempts. Try again later.' });
    }

    // Fetch user
    const { data: user } = await supabase.from('users').select('*').eq('email', email).maybeSingle();
    const userPassword = user?.encrypted_password || user?.password || '';
    const dummyHash = '$2b$12$C6UzMDM.H6dfI/f/IKcEeO';
    const passwordMatch = user ? await bcrypt.compare(password, userPassword) : await bcrypt.compare(dummyHash, dummyHash);

    if (!user || !passwordMatch || !user.verified || user.is_honeytoken) {
      await logAttempt(ip + email);
      await randomDelay();
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    if (!passwordStrongEnough(password)) {
      return res.status(400).json({ success: false, error: 'Password does not meet strength requirements' });
    }

    const deviceFingerprint = getDeviceFingerprint(req.headers, fingerprint);

    // CAPTCHA only on initial login
    if (!verification_code) {
      if (!(await verifyCaptcha(captcha_token, ip))) {
        await logAttempt(ip + email);
        await randomDelay();
        return res.status(403).json({ success: false, error: 'CAPTCHA verification failed' });
      }
    }

    // ZERO TRUST: email verification required every login
    if (!verification_code) {
      const code = generateVerificationCode();
      const { error: upsertError } = await supabase.from('pending_verifications').upsert(
        {
          email,
          code,
          fingerprint: deviceFingerprint,
          expires_at: new Date(Date.now() + 60 * 1000)
        },
        { onConflict: ['email', 'fingerprint'] }
      );

      if (upsertError) throw upsertError;
      await sendVerificationEmail(email, code);
      return res.status(200).json({
        success: true,
        verification_required: true,
        message: 'Verification code sent to your email. It expires in 1 minute.'
      });
    }

    // Verify email code
    const { data: pending } = await supabase
      .from('pending_verifications')
      .select('*')
      .eq('email', email)
      .eq('fingerprint', deviceFingerprint)
      .maybeSingle();

    if (!pending || pending.code !== verification_code || new Date(pending.expires_at) < new Date()) {
      return res.status(401).json({ success: false, error: 'Invalid or expired verification code' });
    }

    await supabase
      .from('pending_verifications')
      .delete()
      .eq('email', email)
      .eq('fingerprint', deviceFingerprint);

    // Create session
    const session_token = generateEncryptedToken();
    const expiresInDays = remember_me ? 90 : 1;

    const { error: sessionError } = await supabase.from('sessions').insert({
      user_email: email,
      session_token,
      expires_at: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000),
      verified: true
    });

    if (sessionError) {
      console.error('Session insert failed:', sessionError);
      return res.status(500).json({ success: false, error: 'Failed to create session', details: sessionError.message });
    }

    await supabase.from('users').update({ last_fingerprint: deviceFingerprint }).eq('email', email);

    // Return cookie + success
    res.setHeader(
      'Set-Cookie',
      `__Host-session_secure=${session_token}; Path=/; HttpOnly; Secure; Max-Age=${expiresInDays * 24 * 60 * 60}; SameSite=Strict`
    );

    return res.status(200).json({ success: true, message: 'Verification complete. Login successful!' });
  } catch (err) {
    console.error('LOGIN ERROR:', err);
    return res.status(500).json({ success: false, error: 'Internal server error', details: err.message });
  }
}
