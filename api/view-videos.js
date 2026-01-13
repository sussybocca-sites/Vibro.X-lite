// pages/api/view-videos.js (UPDATED)
import { createClient } from '@supabase/supabase-js';
import cookie from 'cookie';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  try {
    let userId = null;
    
    // Check if user is authenticated
    const cookies = req.headers.cookie ? cookie.parse(req.headers.cookie) : {};
    const sessionToken = cookies['__Host-session_secure'];
    
    if (sessionToken) {
      const { data: session } = await supabase
        .from('sessions')
        .select('user_id, expires_at')
        .eq('session_token', sessionToken)
        .maybeSingle();

      if (session && new Date(session.expires_at) > new Date()) {
        userId = session.user_id;
      }
    }

    // Handle POST: add a new comment
    if (req.method === 'POST') {
      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const { videoId } = req.query;
      const { text } = req.body;

      if (!text) return res.status(400).json({ error: 'Comment text required' });
      if (!videoId) return res.status(400).json({ error: 'Video ID required' });

      // Verify video exists
      const { data: video } = await supabase
        .from('videos')
        .select('id, user_id')
        .eq('id', videoId)
        .maybeSingle();

      if (!video) return res.status(404).json({ error: 'Video not found' });

      // Insert comment
      const { data: newComment, error } = await supabase
        .from('comments')
        .insert({
          user_id: userId,
          video_id: videoId,
          comment_text: text
        })
        .select(`
          id,
          user_id,
          video_id,
          comment_text,
          created_at,
          users ( id, username, email, avatar_url )
        `)
        .single();

      if (error) return res.status(500).json({ error: error.message });

      // Send notification to video owner if not commenting on own video
      if (video.user_id !== userId) {
        await supabase
          .from('notifications')
          .insert({
            user_id: video.user_id,
            from_user_id: userId,
            type: 'video_comment',
            video_id: videoId,
            message: 'commented on your video',
            read: false,
            created_at: new Date().toISOString()
          });
      }

      return res.status(200).json({
        id: newComment.id,
        text: newComment.comment_text,
        created_at: newComment.created_at,
        user: newComment.users
      });
    }

    // Handle GET: list videos with likes and views
    if (req.method === 'GET') {
      // Get videos from database (not storage)
      const { data: videos, error: videosError } = await supabase
        .from('videos')
        .select(`
          id,
          user_id,
          title,
          description,
          video_url,
          cover_url,
          original_filename,
          mime_type,
          size,
          views,
          created_at,
          users ( id, email, username, avatar_url, online )
        `)
        .order('created_at', { ascending: false })
        .limit(100);

      if (videosError) return res.status(500).json({ error: videosError.message });
      if (!videos || videos.length === 0) return res.status(200).json([]);

      // Build response with additional data
      const result = await Promise.all(
        videos.map(async (video) => {
          // Get like count and check if user liked
          const { count: likes } = await supabase
            .from('likes')
            .select('*', { count: 'exact', head: true })
            .eq('video_id', video.id);

          let hasLiked = false;
          if (userId) {
            const { data: userLike } = await supabase
              .from('likes')
              .select('id')
              .eq('user_id', userId)
              .eq('video_id', video.id)
              .maybeSingle();
            hasLiked = !!userLike;
          }

          // Increment view count (only count once per session)
          if (req.headers['x-view-increment'] === 'true') {
            await supabase
              .from('videos')
              .update({ views: (video.views || 0) + 1 })
              .eq('id', video.id);
          }

          // Get signed URLs
          let videoUrl = null;
          if (video.video_url) {
            const { data } = await supabase.storage
              .from('videos')
              .createSignedUrl(video.video_url, 3600);
            videoUrl = data?.signedUrl || null;
          }

          let coverUrl = null;
          if (video.cover_url) {
            const { data } = await supabase.storage
              .from('covers')
              .createSignedUrl(video.cover_url, 3600);
            coverUrl = data?.signedUrl || null;
          }

          // Get comments
          const { data: comments } = await supabase
            .from('comments')
            .select(`
              id,
              user_id,
              video_id,
              comment_text,
              created_at,
              edited_at,
              users ( id, username, email, avatar_url )
            `)
            .eq('video_id', video.id)
            .order('created_at', { ascending: true });

          return {
            id: video.id,
            name: video.video_url,
            title: video.title,
            description: video.description,
            likes: likes || 0,
            hasLiked,
            views: video.views || 0,
            uploaded_at: video.created_at,
            videoUrl,
            coverUrl,
            user: video.users,
            comments: (comments || []).map(c => ({
              id: c.id,
              user_id: c.user_id,
              video_id: c.video_id,
              text: c.comment_text,
              created_at: c.created_at,
              edited_at: c.edited_at,
              user: c.users
            }))
          };
        })
      );

      return res.status(200).json(result);
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('Video API crash:', err);
    res.status(500).json({ error: err.message });
  }
}
