import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Encrypt the video filename for front-end display
function encryptVideoUrl(videoName) {
  const hash = crypto.createHash('sha256').update(videoName).digest('hex').slice(0, 8);
  const encoded = Buffer.from(videoName).toString('base64url');
  return `/ECR/V/${hash}_${encoded}`;
}

export default async function handler(req, res) {
  try {
    // Get all files in the 'videos' storage bucket
    const { data: files, error: listError } = await supabase
      .storage
      .from('videos')
      .list('', { limit: 100, offset: 0 });

    if (listError) return res.status(500).json({ error: listError.message });
    if (!files || files.length === 0) return res.status(200).json([]);

    const videosWithUserAndComments = await Promise.all(
      files.map(async (file) => {
        // Get video metadata
        const { data: videoRecord, error: videoError } = await supabase
          .from('videos')
          .select('id, user_id, created_at, cover_url, title, description, video_url')
          .eq('video_url', file.name)
          .maybeSingle();

        if (videoError || !videoRecord) return null;

        // Count likes
        const { data: votesData } = await supabase
          .from('votes')
          .select('id', { count: 'exact' })
          .eq('item_type', 'video')
          .eq('item_id', videoRecord.id);
        const likesCount = votesData ? votesData.length : 0;

        // Encrypted video path for front-end
        const encryptedVideoUrl = encryptVideoUrl(videoRecord.video_url);

        // Cover art signed URL
        let coverUrl = null;
        if (videoRecord.cover_url) {
          const { data: signedCoverData, error: signedCoverError } = await supabase
            .storage
            .from('covers')
            .createSignedUrl(videoRecord.cover_url, 3600);
          if (!signedCoverError) coverUrl = signedCoverData.signedUrl;
        }

        // Fetch user info
        const { data: userData } = await supabase
          .from('users')
          .select('id, email, username, avatar_url, online')
          .eq('id', videoRecord.user_id)
          .maybeSingle();

        const user = userData ? {
          id: userData.id,
          email: userData.email,
          username: userData.username,
          avatar_url: userData.avatar_url,
          online: userData.online || false
        } : null;

        // Fetch comments joined with users
        const { data: commentsData } = await supabase
          .from('comments')
          .select(`
            id,
            comment_text,
            created_at,
            likes_count,
            user:users(id, username, email, avatar_url)
          `)
          .eq('video_id', videoRecord.id)
          .order('created_at', { ascending: true });

        const commentsWithUsers = (commentsData || []).map(c => ({
          id: c.id,
          user: c.user ? {
            id: c.user.id,
            username: c.user.username,
            email: c.user.email,
            avatar_url: c.user.avatar_url
          } : { username: 'Unknown' },
          text: c.comment_text,
          created_at: c.created_at,
          likes: c.likes_count || 0
        }));

        return {
          id: videoRecord.id,
          name: file.name,
          title: videoRecord.title,
          description: videoRecord.description,
          likes: likesCount,
          uploaded_at: videoRecord.created_at ? new Date(videoRecord.created_at).toISOString() : null,
          videoUrl: encryptedVideoUrl, // encrypted
          coverUrl,
          user,
          comments: commentsWithUsers
        };
      })
    );

    res.status(200).json(videosWithUserAndComments.filter(v => v));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
