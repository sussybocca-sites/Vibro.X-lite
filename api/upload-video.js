// pages/api/upload-video.js (UPDATED)
import { createClient } from '@supabase/supabase-js';
import cookie from 'cookie';
import { v4 as uuidv4 } from 'uuid';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export const config = {
  api: {
    bodyParser: false,
  },
};

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

    // Parse multipart form data
    const Busboy = require('busboy');
    const busboy = Busboy({ 
      headers: req.headers,
      limits: {
        fileSize: MAX_FILE_SIZE,
        files: 2
      }
    });

    let videoFile = null;
    let coverFile = null;
    let videoTitle = '';
    let description = '';
    let tags = '';

    busboy.on('field', (name, value) => {
      if (name === 'title') videoTitle = value.trim();
      if (name === 'description') description = value.trim();
      if (name === 'tags') tags = value.trim();
    });

    busboy.on('file', (name, file, info) => {
      const { filename, mimeType } = info;
      const chunks = [];
      
      file.on('data', (chunk) => {
        chunks.push(chunk);
      });

      file.on('end', async () => {
        const buffer = Buffer.concat(chunks);
        
        if (name === 'video') {
          if (!ALLOWED_VIDEO_TYPES.includes(mimeType)) {
            throw new Error('Invalid video format');
          }
          videoFile = {
            buffer,
            filename,
            mimeType,
            size: buffer.length
          };
        } else if (name === 'cover') {
          if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) {
            throw new Error('Invalid image format');
          }
          coverFile = {
            buffer,
            filename,
            mimeType,
            size: buffer.length
          };
        }
      });

      file.on('error', (err) => {
        console.error('File stream error:', err);
        throw new Error('File upload failed');
      });
    });

    busboy.on('finish', async () => {
      try {
        // Validate required fields
        if (!videoFile) {
          return res.status(400).json({ error: 'No video uploaded' });
        }
        if (!coverFile) {
          return res.status(400).json({ error: 'Cover image is required' });
        }
        if (!videoTitle || videoTitle.length < 3) {
          return res.status(400).json({ error: 'Video title must be at least 3 characters' });
        }

        // Generate unique filenames
        const videoExt = videoFile.filename.split('.').pop();
        const coverExt = coverFile.filename.split('.').pop();
        const videoId = uuidv4();
        const videoName = `${userId}/${videoId}.${videoExt}`;
        const coverName = `${userId}/${videoId}.${coverExt}`;

        // Upload video to storage
        const { error: videoUploadError } = await supabase.storage
          .from('videos')
          .upload(videoName, videoFile.buffer, {
            contentType: videoFile.mimeType,
            cacheControl: '3600'
          });

        if (videoUploadError) {
          console.error('Video upload failed:', videoUploadError);
          return res.status(500).json({ error: 'Failed to upload video' });
        }

        // Upload cover to storage
        const { error: coverUploadError } = await supabase.storage
          .from('covers')
          .upload(coverName, coverFile.buffer, {
            contentType: coverFile.mimeType,
            cacheControl: '3600'
          });

        if (coverUploadError) {
          console.error('Cover upload failed:', coverUploadError);
          await supabase.storage.from('videos').remove([videoName]);
          return res.status(500).json({ error: 'Failed to upload cover' });
        }

        // Create video record in database
        const { data: video, error: dbError } = await supabase
          .from('videos')
          .insert({
            id: videoId,
            user_id: userId,
            title: videoTitle,
            description: description,
            video_url: videoName,
            cover_url: coverName,
            original_filename: videoFile.filename,
            mime_type: videoFile.mimeType,
            size: videoFile.size,
            views: 0,
            tags: tags.split(',').map(tag => tag.trim()).filter(tag => tag),
            created_at: new Date().toISOString()
          })
          .select()
          .single();

        if (dbError) {
          console.error('Database insert failed:', dbError);
          await supabase.storage.from('videos').remove([videoName]);
          await supabase.storage.from('covers').remove([coverName]);
          return res.status(500).json({ error: 'Failed to save video metadata' });
        }

        // Update user's video count
        await supabase
          .from('users')
          .update({ 
            video_count: supabase.raw('video_count + 1'),
            last_upload: new Date().toISOString()
          })
          .eq('id', userId);

        return res.status(200).json({
          success: true,
          message: 'Video uploaded successfully',
          video: {
            id: videoId,
            title: videoTitle,
            videoUrl: videoName,
            coverUrl: coverName
          }
        });

      } catch (err) {
        console.error('Upload processing error:', err);
        return res.status(500).json({ error: err.message || 'Upload failed' });
      }
    });

    req.pipe(busboy);

  } catch (err) {
    console.error('Upload handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
