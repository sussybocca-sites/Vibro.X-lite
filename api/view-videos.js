import { createClient } from '@supabase/supabase-js';
import cookie from 'cookie';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  try {
    // 1️⃣ Get session
    const cookies = req.headers.cookie ? cookie.parse(req.headers.cookie) : {};
    const sessionToken = cookies['__Host-session_secure'];

    if (!sessionToken) return res.status(401).json({ error: 'Not authenticated' });

    const { data: session } = await supabase
      .from('sessions')
      .select('user_id, expires_at')
      .eq('session_token', sessionToken)
      .maybeSingle();

    if (!session || new Date(session.expires_at) < new Date()) {
      return res.status(401).json({ error: 'Session expired or invalid' });
    }

    // 2️⃣ Load storage files
    const { data: files, error: listError } = await supabase
      .storage
      .from('videos')
      .list('', { limit: 100, offset: 0 });

    if (listError) return res.status(500).json({ error: listError.message });
    if (!files || files.length === 0) return res.status(200).json([]);

    // 3️⃣ Build response
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

        const videoUrl = (await supabase.storage.from('videos')
          .createSignedUrl(video.video_url, 3600)).data?.signedUrl || null;

        const coverUrl = (await supabase.storage.from('covers')
          .createSignedUrl(video.cover_url, 3600)).data?.signedUrl || null;

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

    res.status(200).json(result.filter(Boolean));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
