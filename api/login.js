import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import nodemailer from 'nodemailer';

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL, 
  process.env.SUPABASE_KEY || process.env.SUPABASE_KEY,
  {
    auth: {
      persistSession: false
    }
  }
);

// Nodemailer transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Rate limiting functions (simplified for Vercel)
const rateLimitCache = new Map();

async function checkRateLimit(key) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000; // 15 minutes
  const maxAttempts = 5;
  
  const attempts = rateLimitCache.get(key) || [];
  const recentAttempts = attempts.filter(time => now - time < windowMs);
  
  if (recentAttempts.length >= maxAttempts) {
    return false;
  }
  
  recentAttempts.push(now);
  rateLimitCache.set(key, recentAttempts);
  return true;
}

async function logAttempt(key) {
  const attempts = rateLimitCache.get(key) || [];
  attempts.push(Date.now());
  rateLimitCache.set(key, attempts);
}

// Verify CAPTCHA
async function verifyCaptcha(token, ip) {
  if (!token) return false;
  const secret = process.env.CAPTCHA_SECRET_KEY;

  try {
    const res = await fetch('https://hcaptcha.com/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${secret}&response=${token}&remoteip=${ip}`
    });

    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.error('CAPTCHA ERROR:', err);
    return false;
  }
}

// Device fingerprint hash
function getDeviceFingerprint(headers, frontendFingerprint) {
  const source = frontendFingerprint || 
    (headers['user-agent'] || '') + 
    (headers['accept-language'] || '') + 
    (headers['x-forwarded-for'] || '') + 
    uuidv4();
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
  const key = crypto.scryptSync(process.env.SESSION_SECRET || 'fallback-secret-key-32-bytes-long-here', 'salt', 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const uuid = uuidv4();
  const encrypted = cipher.update(uuid, 'utf8', 'hex') + cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

// Send verification email
async function sendVerificationEmail(email, code) {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Verify Your Login',
      text: `Your verification code is: ${code}\nIt expires in 1 minute.`,
      html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Login Verification Code</h2>
        <p>Your verification code is: <strong style="font-size: 24px; letter-spacing: 5px;">${code}</strong></p>
        <p>This code will expire in <strong>1 minute</strong>.</p>
        <p>If you didn't request this code, please ignore this email.</p>
        <hr style="border: 1px solid #eee; margin: 20px 0;">
        <p style="color: #666; font-size: 12px;">This is an automated message, please do not reply.</p>
      </div>`
    });
    return true;
  } catch (err) {
    console.error('EMAIL ERROR:', err);
    return false;
  }
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

// ----------------- MAIN HANDLER -----------------
export default async function handler(req, res) {
  // Set CORS headers for Vercel
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    // Parse body for Vercel
    let body;
    if (typeof req.body === 'string') {
      try {
        body = JSON.parse(req.body);
      } catch (e) {
        body = req.body;
      }
    } else {
      body = req.body;
    }

    const {
      email,
      password,
      remember_me,
      captcha_token,
      google,
      fingerprint,
      verification_code
    } = body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    const ip = req.headers['x-forwarded-for'] || req.headers['client-ip'] || req.socket?.remoteAddress || 'unknown';

    // Google login - update path for Vercel
    if (google) {
      return res.status(200).json({ 
        success: true, 
        redirect: '/api/auth/google' 
      });
    }

    // Rate limit check
    const allowed = await checkRateLimit(ip + email);
    if (!allowed) {
      return res.status(429).json({ 
        success: false, 
        error: 'Too many login attempts. Please try again in 15 minutes.' 
      });
    }

    // Fetch user from Supabase - select specific columns
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, email, username, verified, suspended, suspension_reason, is_honeytoken, limited_account, spam_score, last_login, password, encrypted_password, profile_picture, completed_profile')
      .eq('email', email)
      .maybeSingle();

    if (userError) {
      console.error('Supabase fetch error:', userError);
      await logAttempt(ip + email);
      await randomDelay();
      return res.status(500).json({ 
        success: false, 
        error: 'Authentication service temporarily unavailable' 
      });
    }

    // Handle password verification securely
    let passwordValid = false;
    if (user) {
      // Try both password fields from your schema
      const passwordToCheck = user.encrypted_password || user.password || '';
      if (passwordToCheck) {
        passwordValid = await bcrypt.compare(password, passwordToCheck);
      }
    }
    
    // If no user or password invalid, use dummy comparison
    if (!user || !passwordValid) {
      // Perform dummy comparison to prevent timing attacks
      const dummyHash = '$2b$12$C6UzMDM.H6dfI/f/IKcEeO';
      await bcrypt.compare(password, dummyHash);
      
      await logAttempt(ip + email);
      await randomDelay();
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid email or password' 
      });
    }

    // Check user status
    if (user.suspended) {
      return res.status(403).json({ 
        success: false, 
        error: user.suspension_reason || 'Account suspended. Please contact support.' 
      });
    }

    if (user.is_honeytoken) {
      console.warn(`Honeytoken access attempt detected: ${email} from ${ip}`);
      await logAttempt(ip + email);
      await randomDelay();
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid email or password' 
      });
    }

    // Check if verified (assuming your schema has this field)
    if (user.verified === false) {
      return res.status(403).json({ 
        success: false, 
        error: 'Please verify your email address before logging in.' 
      });
    }

    if (!passwordStrongEnough(password)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Password does not meet security requirements. Must be 8+ characters with uppercase, lowercase, number, and special character.' 
      });
    }

    const deviceFingerprint = getDeviceFingerprint(req.headers, fingerprint);

    // CAPTCHA check for first login attempt
    if (!verification_code) {
      const captchaOk = await verifyCaptcha(captcha_token, ip);
      if (!captchaOk) {
        await logAttempt(ip + email);
        await randomDelay();
        return res.status(403).json({ 
          success: false, 
          error: 'CAPTCHA verification failed. Please try again.' 
        });
      }
    }

    // ZERO TRUST: email verification required
    if (!verification_code) {
      const code = generateVerificationCode();
      
      // Store verification code
      const { error: upsertError } = await supabase
        .from('pending_verifications')
        .upsert({
          email,
          code,
          fingerprint: deviceFingerprint,
          expires_at: new Date(Date.now() + 60 * 1000).toISOString()
        }, {
          onConflict: 'email, fingerprint'
        });

      if (upsertError) {
        console.error('Supabase upsert error:', upsertError);
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to generate verification code' 
        });
      }

      // Send email
      const emailSent = await sendVerificationEmail(email, code);
      if (!emailSent) {
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to send verification email. Please try again.' 
        });
      }

      return res.status(200).json({
        success: true,
        verification_required: true,
        message: 'Verification code sent to your email. It expires in 1 minute.',
        email_sent: true
      });
    }

    // Verify email code
    const { data: pending, error: pendingError } = await supabase
      .from('pending_verifications')
      .select('*')
      .eq('email', email)
      .eq('fingerprint', deviceFingerprint)
      .maybeSingle();

    if (pendingError) {
      console.error('Supabase pending fetch error:', pendingError);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to verify code' 
      });
    }

    if (!pending || pending.code !== verification_code) {
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid verification code' 
      });
    }

    // Check expiration
    if (new Date(pending.expires_at) < new Date()) {
      // Clean up expired code
      await supabase
        .from('pending_verifications')
        .delete()
        .eq('email', email)
        .eq('fingerprint', deviceFingerprint);
        
      return res.status(401).json({ 
        success: false, 
        error: 'Verification code has expired. Please request a new one.' 
      });
    }

    // Clean up verification code
    await supabase
      .from('pending_verifications')
      .delete()
      .eq('email', email)
      .eq('fingerprint', deviceFingerprint);

    // Update user last login info
    const { error: updateError } = await supabase
      .from('users')
      .update({ 
        last_fingerprint: deviceFingerprint,
        last_login: new Date().toISOString(),
        online: true
      })
      .eq('id', user.id);

    if (updateError) {
      console.error('Failed to update user:', updateError);
    }

    // Create session token
    const session_token = generateEncryptedToken();
    const expiresInDays = remember_me ? 90 : 1;
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

    // Create session record - handle potential foreign key issues
    const sessionData = {
      user_id: user.id,
      user_email: email,
      session_token,
      expires_at: expiresAt.toISOString(),
      verified: true,
      context: {
        ip,
        user_agent: req.headers['user-agent'],
        timestamp: new Date().toISOString()
      }
    };

    const { error: sessionError } = await supabase
      .from('sessions')
      .insert(sessionData);

    if (sessionError) {
      console.error('Session insert failed:', sessionError);
      
      // If foreign key error, try without user_id
      if (sessionError.message.includes('foreign key constraint')) {
        delete sessionData.user_id;
        const { error: retryError } = await supabase
          .from('sessions')
          .insert(sessionData);
          
        if (retryError) {
          console.error('Retry session insert failed:', retryError);
          return res.status(500).json({ 
            success: false, 
            error: 'Failed to create session. Please try again.' 
          });
        }
      } else {
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to create session' 
        });
      }
    }

    // Set secure cookie for Vercel
    const cookieOptions = [
      `__Host-session_secure=${session_token}`,
      'Path=/',
      'HttpOnly',
      'Secure',
      `Max-Age=${expiresInDays * 24 * 60 * 60}`,
      'SameSite=Strict'
    ].join('; ');

    res.setHeader('Set-Cookie', cookieOptions);

    return res.status(200).json({
      success: true,
      message: 'Login successful!',
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        profile_picture: user.profile_picture,
        completed_profile: user.completed_profile
      },
      session_expires: expiresAt.toISOString()
    });

  } catch (err) {
    console.error('LOGIN ERROR:', err);
    return res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
}
