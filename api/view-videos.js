import { createClient } from '@supabase/supabase-js';
import cookie from 'cookie';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  try {
    // 1️⃣ Get session from cookie
    const cookies = req.headers.cookie ? cookie.parse(req.headers.cookie) : {};
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

    // 2️⃣ Handle POST: add a new comment
    if (req.method === 'POST') {
      const { videoId } = req.query;
      const { text } = req.body;

      if (!text) return res.status(400).json({ error: 'Comment text required' });
      if (!videoId) return res.status(400).json({ error: 'Video ID required' });

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

      return res.status(200).json({
        id: newComment.id,
        text: newComment.comment_text,
        created_at: newComment.created_at,
        user: newComment.users
      });
    }

    // 3️⃣ Handle GET: list videos with comments
    if (req.method === 'GET') {
      // Load storage files
      const { data: files, error: listError } = await supabase
        .storage
        .from('videos')
        .list('', { limit: 100, offset: 0 });

      if (listError) return res.status(500).json({ error: listError.message });
      if (!files || files.length === 0) return res.status(200).json([]);

      // Build response
      const result = await Promise.all(
        files.map(async (file) => {
          const { data: video } = await supabase
            .from('videos')
            .select('id, user_id, created_at, cover_url, title, description, video_url')
            .eq('video_url', file.name)
            .maybeSingle();

          if (!video) return null;

          const { data: votes } = await supabase
            .from('votes')
            .select('id')
            .eq('item_type', 'video')
            .eq('item_id', video.id);

          const likes = votes?.length || 0;

          // Safe signed URLs
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

          const { data: user } = await supabase
            .from('users')
            .select('id, email, username, avatar_url, online')
            .eq('id', video.user_id)
            .maybeSingle();

          const { data: comments } = await supabase
            .from('comments')
            .select(`
              id,
              user_id,
              video_id,
              comment_text,
              created_at,
              edited_at,
              likes_count,
              users ( id, username, email, avatar_url )
            `)
            .eq('video_id', video.id)
            .order('created_at', { ascending: true });

          return {
            id: video.id,
            name: file.name,
            title: video.title,
            description: video.description,
            likes,
            uploaded_at: video.created_at,
            videoUrl,
            coverUrl,
            user,
            comments: (comments || []).map(c => ({
              id: c.id,
              user_id: c.user_id,
              video_id: c.video_id,
              text: c.comment_text,
              created_at: c.created_at,
              edited_at: c.edited_at,
              likes: c.likes_count,
              user: c.users
            }))
          };
        })
      );

      return res.status(200).json(result.filter(Boolean));
    }

    // 4️⃣ Unsupported method
    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('Video API crash:', err);
    res.status(500).json({ error: err.message });
  }
}
