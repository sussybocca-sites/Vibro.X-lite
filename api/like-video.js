// pages/api/like-video.js
import { createClient } from '@supabase/supabase-js';
import cookie from 'cookie';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Verify session
    const cookies = cookie.parse(req.headers.cookie || '');
    const sessionToken = cookies['__Host-session_secure'];

    if (!sessionToken) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { data: session } = await supabase
      .from('sessions')
      .select('user_id, expires_at')
      .eq('session_token', sessionToken)
      .maybeSingle();

    if (!session || new Date(session.expires_at) < new Date()) {
      return res.status(401).json({ error: 'Session expired or invalid' });
    }

    const userId = session.user_id;
    const { videoId, action } = req.body; // action: 'like' or 'unlike'

    if (!videoId || !action) {
      return res.status(400).json({ error: 'Missing videoId or action' });
    }

    // Verify video exists
    const { data: video } = await supabase
      .from('videos')
      .select('id, user_id')
      .eq('id', videoId)
      .maybeSingle();

    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    if (action === 'like') {
      // Check if already liked
      const { data: existingLike } = await supabase
        .from('likes')
        .select('id')
        .eq('user_id', userId)
        .eq('video_id', videoId)
        .maybeSingle();

      if (existingLike) {
        return res.status(400).json({ error: 'Already liked' });
      }

      // Add like
      const { error } = await supabase
        .from('likes')
        .insert({
          user_id: userId,
          video_id: videoId,
          created_at: new Date().toISOString()
        });

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      // Send notification to video owner if not liking own video
      if (video.user_id !== userId) {
        await supabase
          .from('notifications')
          .insert({
            user_id: video.user_id,
            from_user_id: userId,
            type: 'video_like',
            video_id: videoId,
            message: 'liked your video',
            read: false,
            created_at: new Date().toISOString()
          });
      }

    } else if (action === 'unlike') {
      // Remove like
      const { error } = await supabase
        .from('likes')
        .delete()
        .eq('user_id', userId)
        .eq('video_id', videoId);

      if (error) {
        return res.status(500).json({ error: error.message });
      }
    } else {
      return res.status(400).json({ error: 'Invalid action' });
    }

    // Get updated like count
    const { count: likes } = await supabase
      .from('likes')
      .select('*', { count: 'exact', head: true })
      .eq('video_id', videoId);

    // Check if user currently likes the video
    const { data: userLike } = await supabase
      .from('likes')
      .select('id')
      .eq('user_id', userId)
      .eq('video_id', videoId)
      .maybeSingle();

    return res.status(200).json({
      success: true,
      likes: likes || 0,
      liked: !!userLike
    });

  } catch (err) {
    console.error('Like video API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
