import { createClient } from '@supabase/supabase-js';
import cookie from 'cookie';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  // Set CORS headers for Vercel
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    // Parse cookies
    const cookies = cookie.parse(req.headers.cookie || '');
    const sessionToken = cookies['__Host-session_secure'] || cookies.session_secure;

    console.log('🔍 Session validation attempt');
    console.log('📦 Cookies received:', Object.keys(cookies));
    console.log('🔑 Session token found:', !!sessionToken);

    if (!sessionToken) {
      return res.status(200).json({ 
        success: false, 
        authenticated: false,
        error: 'No session token found' 
      });
    }

    // First, just get the session without the join (to avoid foreign key issues)
    console.log('📊 Querying sessions table...');
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('*')
      .eq('session_token', sessionToken)
      .maybeSingle();

    if (sessionError) {
      console.error('❌ Session query error:', sessionError);
      return res.status(500).json({ 
        success: false, 
        authenticated: false,
        error: 'Database error',
        debug: sessionError.message
      });
    }

    console.log('✅ Session found:', !!session);
    if (session) {
      console.log('📝 Session details:', {
        id: session.id,
        user_id: session.user_id,
        user_email: session.user_email,
        expires_at: session.expires_at,
        verified: session.verified
      });
    }

    if (!session) {
      return res.status(200).json({ 
        success: false, 
        authenticated: false,
        error: 'Session not found' 
      });
    }

    // Check if session is expired
    const now = new Date();
    const expiresAt = new Date(session.expires_at);
    
    console.log('⏰ Session expiry check:', {
      now: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      is_expired: expiresAt < now
    });

    if (expiresAt < now) {
      console.log('🗑️ Deleting expired session');
      await supabase
        .from('sessions')
        .delete()
        .eq('session_token', sessionToken);
        
      return res.status(200).json({ 
        success: false, 
        authenticated: false,
        error: 'Session expired' 
      });
    }

    // Now get user data using user_email (more reliable than user_id due to FK issues)
    let user = null;
    console.log('👤 Fetching user data...');
    
    if (session.user_email) {
      console.log('📧 Using email to find user:', session.user_email);
      const { data: userByEmail, error: userError } = await supabase
        .from('users')
        .select('*')
        .eq('email', session.user_email)
        .maybeSingle();
      
      user = userByEmail;
      
      if (userError) {
        console.error('❌ User query error:', userError);
      }
      
      console.log('✅ User found by email:', !!userByEmail);
      
      // If we found user by email but session has wrong user_id, update it
      if (userByEmail && (!session.user_id || session.user_id !== userByEmail.id)) {
        console.log('🔄 Fixing session user_id mismatch');
        console.log('Old user_id:', session.user_id, 'New user_id:', userByEmail.id);
        
        try {
          await supabase
            .from('sessions')
            .update({ user_id: userByEmail.id })
            .eq('session_token', sessionToken);
          console.log('✅ Session user_id updated');
        } catch (updateError) {
          console.error('⚠️ Could not update session user_id:', updateError.message);
          // This is expected if the FK constraint fails
        }
      }
    }

    // If still no user, try by user_id (might work if it's a valid UUID in auth.users)
    if (!user && session.user_id) {
      console.log('🆔 Trying to find user by ID:', session.user_id);
      const { data: userById } = await supabase
        .from('users')
        .select('*')
        .eq('id', session.user_id)
        .maybeSingle();
      
      user = userById;
      console.log('✅ User found by ID:', !!userById);
    }

    if (!user) {
      console.error('❌ No user found for session');
      // Delete orphaned session
      await supabase
        .from('sessions')
        .delete()
        .eq('session_token', sessionToken);
        
      return res.status(200).json({ 
        success: false, 
        authenticated: false,
        error: 'User account not found' 
      });
    }

    console.log('👤 User details:', {
      id: user.id,
      email: user.email,
      username: user.username,
      verified: user.verified,
      suspended: user.suspended
    });

    // Check if user is suspended
    if (user.suspended) {
      console.log('🚫 User is suspended');
      return res.status(200).json({ 
        success: false, 
        authenticated: true,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          suspended: true,
          suspension_reason: user.suspension_reason
        },
        error: 'Account suspended: ' + (user.suspension_reason || 'Contact support')
      });
    }

    // Update user's online status and last_online
    console.log('🔄 Updating user online status');
    await supabase
      .from('users')
      .update({ 
        online: true,
        last_online: new Date().toISOString()
      })
      .eq('id', user.id);

    // Return user data
    const userData = {
      id: user.id,
      email: user.email,
      username: user.username,
      profile_picture: user.profile_picture,
      avatar_url: user.avatar_url || user.profile_picture, // Support both fields
      created_at: user.created_at,
      online: true,
      bio: user.bio,
      verified: user.verified,
      completed_profile: user.completed_profile,
      last_online: user.last_online,
      google_linked: user.google_linked,
      fbx_avatar_ids: user.fbx_avatar_ids,
      suspended: user.suspended || false,
      video_count: user.video_count || 0,
      session_expires: session.expires_at
    };

    console.log('🎉 Session validated successfully for:', user.email);

    return res.status(200).json({
      success: true,
      authenticated: true,
      user: userData,
      session: {
        expires_at: session.expires_at,
        created_at: session.created_at
      }
    });

  } catch (err) {
    console.error('💥 /api/me error:', err);
    return res.status(500).json({ 
      success: false, 
      authenticated: false,
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
}
