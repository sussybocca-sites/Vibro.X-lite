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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    // Verify session
    const cookies = cookie.parse(req.headers.cookie || '');
    const sessionToken = cookies['__Host-session_secure'] || cookies.session_secure;

    console.log('🔍 Like video request - Session token found:', !!sessionToken);

    if (!sessionToken) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }

    // Get session with user_email (more reliable due to FK constraints)
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('user_email, expires_at')
      .eq('session_token', sessionToken)
      .maybeSingle();

    if (sessionError || !session) {
      console.error('Session error:', sessionError);
      return res.status(401).json({ success: false, error: 'Session expired or invalid' });
    }

    // Check if session is expired
    if (new Date(session.expires_at) < new Date()) {
      await supabase
        .from('sessions')
        .delete()
        .eq('session_token', sessionToken);
      return res.status(401).json({ success: false, error: 'Session expired' });
    }

    // Get user by email (since user_id might not be reliable due to FK constraints)
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, email, username')
      .eq('email', session.user_email)
      .maybeSingle();

    if (userError || !user) {
      return res.status(401).json({ success: false, error: 'User not found' });
    }

    const userEmail = user.email;
    const userId = user.id;
    const { videoId, action } = req.body; // action: 'like' or 'unlike'

    console.log('📝 Like request:', { userEmail, videoId, action });

    if (!videoId || !action) {
      return res.status(400).json({ success: false, error: 'Missing videoId or action' });
    }

    // Verify video exists
    const { data: video, error: videoError } = await supabase
      .from('videos')
      .select('id, user_id, title')
      .eq('id', videoId)
      .maybeSingle();

    if (videoError || !video) {
      console.error('Video error:', videoError);
      return res.status(404).json({ success: false, error: 'Video not found' });
    }

    // Get video owner for notifications
    const { data: videoOwner } = await supabase
      .from('users')
      .select('id, email, username')
      .eq('id', video.user_id)
      .maybeSingle();

    if (action === 'like') {
      // Check if already liked
      // Your likes table structure: user_email, target_type, target_id
      const { data: existingLike, error: checkError } = await supabase
        .from('likes')
        .select('id')
        .eq('user_email', userEmail)
        .eq('target_type', 'video')
        .eq('target_id', videoId)
        .maybeSingle();

      if (checkError) {
        console.error('Check like error:', checkError);
        return res.status(500).json({ success: false, error: 'Error checking like status' });
      }

      if (existingLike) {
        return res.status(400).json({ success: false, error: 'Already liked this video' });
      }

      // Add like - matches your schema: user_email, target_type, target_id
      const { error: insertError } = await supabase
        .from('likes')
        .insert({
          user_email: userEmail,
          target_type: 'video',
          target_id: videoId,
          created_at: new Date().toISOString()
        });

      if (insertError) {
        console.error('Insert like error:', insertError);
        return res.status(500).json({ success: false, error: 'Failed to like video' });
      }

      console.log('✅ Like added:', { userEmail, videoId });

      // Send notification to video owner if not liking own video
      if (videoOwner && videoOwner.id !== userId) {
        try {
          await supabase
            .from('notifications')
            .insert({
              user_id: videoOwner.id,
              type: 'video_like',
              payload: {
                from_user_id: userId,
                from_user_email: userEmail,
                from_username: user.username,
                video_id: videoId,
                video_title: video.title,
                message: `${user.username || 'Someone'} liked your video "${video.title || 'your video'}"`
              },
              read: false,
              created_at: new Date().toISOString()
            });
          console.log('📧 Notification sent to video owner');
        } catch (notifError) {
          console.error('Failed to send notification:', notifError);
          // Don't fail the whole request if notification fails
        }
      }

    } else if (action === 'unlike') {
      // Remove like
      const { error: deleteError } = await supabase
        .from('likes')
        .delete()
        .eq('user_email', userEmail)
        .eq('target_type', 'video')
        .eq('target_id', videoId);

      if (deleteError) {
        console.error('Delete like error:', deleteError);
        return res.status(500).json({ success: false, error: 'Failed to unlike video' });
      }

      console.log('❌ Like removed:', { userEmail, videoId });

    } else {
      return res.status(400).json({ success: false, error: 'Invalid action. Use "like" or "unlike"' });
    }

    // Get updated like count for this video
    const { count: likeCount, error: countError } = await supabase
      .from('likes')
      .select('*', { count: 'exact', head: true })
      .eq('target_type', 'video')
      .eq('target_id', videoId);

    if (countError) {
      console.error('Count error:', countError);
      return res.status(500).json({ success: false, error: 'Failed to get like count' });
    }

    // Check if user currently likes the video
    const { data: currentUserLike } = await supabase
      .from('likes')
      .select('id')
      .eq('user_email', userEmail)
      .eq('target_type', 'video')
      .eq('target_id', videoId)
      .maybeSingle();

    // Update video likes count if you want to cache it (optional)
    try {
      await supabase
        .from('videos')
        .update({ 
          // If you have a likes_count column, update it
          // likes_count: likeCount || 0,
          updated_at: new Date().toISOString()
        })
        .eq('id', videoId);
    } catch (updateError) {
      console.error('Failed to update video:', updateError);
      // Continue anyway - this is optional
    }

    console.log('✅ Like operation completed successfully');

    return res.status(200).json({
      success: true,
      message: action === 'like' ? 'Video liked successfully' : 'Video unliked successfully',
      likes: likeCount || 0,
      liked: !!currentUserLike,
      video_id: videoId,
      user_email: userEmail
    });

  } catch (err) {
    console.error('💥 Like video API error:', err);
    return res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
}
