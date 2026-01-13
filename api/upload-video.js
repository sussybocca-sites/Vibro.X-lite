// pages/api/upload-video.js
import { createClient } from '@supabase/supabase-js';
import cookie from 'cookie';
import { v4 as uuidv4 } from 'uuid';
import busboy from 'busboy';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
const ALLOWED_VIDEO_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/mov',
  'video/avi',
  'video/mkv'
];
const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/jpg'
];

export const config = {
  api: {
    bodyParser: false, // Disable bodyParser to handle multipart/form-data
  },
};

export default async function handler(req, res) {
  // Set CORS headers
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

    if (!sessionToken) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }

    // Get session
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('user_email, expires_at')
      .eq('session_token', sessionToken)
      .maybeSingle();

    if (sessionError || !session) {
      return res.status(401).json({ success: false, error: 'Session expired or invalid' });
    }

    if (new Date(session.expires_at) < new Date()) {
      await supabase.from('sessions').delete().eq('session_token', sessionToken);
      return res.status(401).json({ success: false, error: 'Session expired' });
    }

    // Get user
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, email, username, video_count')
      .eq('email', session.user_email)
      .maybeSingle();

    if (userError || !user) {
      return res.status(401).json({ success: false, error: 'User not found' });
    }

    const userId = user.id;
    
    // Check Content-Type to determine how to handle the request
    const contentType = req.headers['content-type'] || '';
    
    if (contentType.includes('application/json')) {
      // ===== JSON REQUEST (new signed URL system) =====
      let body = '';
      
      req.on('data', chunk => {
        body += chunk.toString();
      });
      
      req.on('end', async () => {
        try {
          const { videoInfo, fileInfo, action } = JSON.parse(body);
          
          if (action === 'prepare') {
            // === STEP 1: PREPARE UPLOAD (Generate signed URLs) ===
            
            if (!videoInfo || !videoInfo.title) {
              return res.status(400).json({ 
                success: false, 
                error: 'Video title is required' 
              });
            }

            if (!fileInfo || !fileInfo.video || !fileInfo.video.name || !fileInfo.video.type) {
              return res.status(400).json({ 
                success: false, 
                error: 'Video file information is required' 
              });
            }

            if (!ALLOWED_VIDEO_TYPES.includes(fileInfo.video.type)) {
              return res.status(400).json({ 
                success: false, 
                error: `Invalid video format: ${fileInfo.video.type}` 
              });
            }

            if (fileInfo.cover && !ALLOWED_IMAGE_TYPES.includes(fileInfo.cover.type)) {
              return res.status(400).json({ 
                success: false, 
                error: `Invalid image format: ${fileInfo.cover.type}` 
              });
            }

            // Generate unique IDs and filenames
            const videoId = uuidv4();
            const videoExt = fileInfo.video.name.split('.').pop().toLowerCase();
            const videoName = `${userId}/${videoId}.${videoExt}`;
            
            let coverName = null;
            if (fileInfo.cover) {
              const coverExt = fileInfo.cover.name.split('.').pop().toLowerCase();
              coverName = `${userId}/${videoId}.${coverExt}`;
            }

            // Generate signed URLs
            const videoSignedUrl = await supabase.storage
              .from('videos')
              .createSignedUploadUrl(videoName);

            if (videoSignedUrl.error) {
              console.error('Failed to generate video signed URL:', videoSignedUrl.error);
              return res.status(500).json({ 
                success: false, 
                error: 'Failed to generate upload URL' 
              });
            }

            let coverSignedUrl = null;
            if (coverName) {
              const coverUrlResult = await supabase.storage
                .from('covers')
                .createSignedUploadUrl(coverName);
              
              if (!coverUrlResult.error) {
                coverSignedUrl = coverUrlResult.data;
              }
            }

            // Create initial video record
            const videoData = {
              id: videoId,
              user_id: userId,
              title: videoInfo.title.trim(),
              description: videoInfo.description ? videoInfo.description.trim() : null,
              video_url: '', // Will be updated after upload
              cover_url: null, // Will be updated after upload
              mime_type: fileInfo.video.type,
              size: fileInfo.video.size || 0,
              original_filename: fileInfo.video.name,
              views: 0,
              ai_generated: videoInfo.aiGenerated || false,
              created_at: new Date().toISOString()
            };

            const { data: video, error: dbError } = await supabase
              .from('videos')
              .insert(videoData)
              .select()
              .single();

            if (dbError) {
              console.error('Database insert failed:', dbError);
              return res.status(500).json({ 
                success: false, 
                error: 'Failed to save video metadata'
              });
            }

            return res.status(200).json({
              success: true,
              message: 'Ready for upload',
              action: 'prepare',
              uploadInfo: {
                videoId,
                signedUrls: {
                  video: videoSignedUrl.data,
                  cover: coverSignedUrl
                },
                fileNames: {
                  video: videoName,
                  cover: coverName
                },
                metadata: video
              }
            });

          } else if (action === 'complete') {
            // === STEP 2: COMPLETE UPLOAD (Update with real URLs) ===
            
            const { videoId, success, error: uploadError } = JSON.parse(body);
            
            if (!videoId) {
              return res.status(400).json({ 
                success: false, 
                error: 'Video ID is required' 
              });
            }

            if (!success) {
              await supabase.from('videos').delete().eq('id', videoId);
              return res.status(400).json({ 
                success: false, 
                error: uploadError || 'Upload failed' 
              });
            }

            // Get the video
            const { data: video } = await supabase
              .from('videos')
              .select('user_id, original_filename')
              .eq('id', videoId)
              .single();

            if (!video) {
              return res.status(404).json({ success: false, error: 'Video not found' });
            }

            // Reconstruct filenames
            const videoName = `${video.user_id}/${videoId}.${video.original_filename.split('.').pop().toLowerCase()}`;
            const coverName = `${video.user_id}/${videoId}.jpg`;

            // Get public URLs
            const { data: videoUrlData } = supabase.storage
              .from('videos')
              .getPublicUrl(videoName);
            
            const { data: coverUrlData } = supabase.storage
              .from('covers')
              .getPublicUrl(coverName);
            
            const videoPublicUrl = videoUrlData.publicUrl;
            const coverPublicUrl = coverUrlData.publicUrl;

            // Update video with real URLs
            const { data: updatedVideo, error: updateError } = await supabase
              .from('videos')
              .update({
                video_url: videoPublicUrl,
                cover_url: coverPublicUrl
              })
              .eq('id', videoId)
              .select()
              .single();

            if (updateError) {
              console.error('Failed to update video URLs:', updateError);
              return res.status(500).json({ 
                success: false, 
                error: 'Failed to update video metadata' 
              });
            }

            // Update user's video count
            await supabase
              .from('users')
              .update({ 
                video_count: (user.video_count || 0) + 1,
                last_upload: new Date().toISOString()
              })
              .eq('id', userId);

            return res.status(200).json({
              success: true,
              message: 'Video uploaded successfully',
              action: 'complete',
              video: updatedVideo
            });

          } else {
            return res.status(400).json({ 
              success: false, 
              error: 'Invalid action' 
            });
          }
        } catch (err) {
          console.error('JSON parsing error:', err);
          return res.status(400).json({ 
            success: false, 
            error: 'Invalid JSON' 
          });
        }
      });
      
    } else if (contentType.includes('multipart/form-data')) {
      // ===== MULTIPART/FORM-DATA REQUEST (original frontend) =====
      return new Promise((resolve) => {
        const bb = busboy({
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

        bb.on('field', (name, value) => {
          if (name === 'title') videoTitle = value.trim();
          if (name === 'description') description = value.trim();
        });

        bb.on('file', (name, file, info) => {
          const { filename, mimeType } = info;
          const chunks = [];
          
          file.on('data', (chunk) => {
            chunks.push(chunk);
          });

          file.on('end', () => {
            const buffer = Buffer.concat(chunks);
            
            if (name === 'video') {
              if (!ALLOWED_VIDEO_TYPES.includes(mimeType)) {
                file.resume();
                return resolve(res.status(400).json({ 
                  success: false, 
                  error: `Invalid video format: ${mimeType}` 
                }));
              }
              
              if (buffer.length > MAX_FILE_SIZE) {
                file.resume();
                return resolve(res.status(400).json({ 
                  success: false, 
                  error: `Video too large: ${(buffer.length / (1024 * 1024)).toFixed(2)}MB` 
                }));
              }
              
              videoFile = {
                buffer,
                filename,
                mimeType,
                size: buffer.length
              };
              
            } else if (name === 'cover') {
              if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) {
                file.resume();
                return resolve(res.status(400).json({ 
                  success: false, 
                  error: `Invalid image format: ${mimeType}` 
                }));
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
            file.resume();
            resolve(res.status(500).json({ 
              success: false, 
              error: 'File upload failed' 
            }));
          });
        });

        bb.on('finish', async () => {
          try {
            if (!videoFile) {
              return resolve(res.status(400).json({ 
                success: false, 
                error: 'No video uploaded' 
              }));
            }
            
            if (!coverFile) {
              return resolve(res.status(400).json({ 
                success: false, 
                error: 'Cover image is required' 
              }));
            }
            
            if (!videoTitle || videoTitle.length < 3) {
              return resolve(res.status(400).json({ 
                success: false, 
                error: 'Video title must be at least 3 characters' 
              }));
            }

            // Generate unique IDs
            const videoId = uuidv4();
            const videoExt = videoFile.filename.split('.').pop().toLowerCase();
            const videoName = `${userId}/${videoId}.${videoExt}`;
            
            const coverExt = coverFile.filename.split('.').pop().toLowerCase();
            const coverName = `${userId}/${videoId}.${coverExt}`;

            // 1. Upload video to storage
            const { error: videoUploadError } = await supabase.storage
              .from('videos')
              .upload(videoName, videoFile.buffer, {
                contentType: videoFile.mimeType,
                cacheControl: 'public, max-age=31536000',
                upsert: false
              });

            if (videoUploadError) {
              console.error('Video upload failed:', videoUploadError);
              return resolve(res.status(500).json({ 
                success: false, 
                error: 'Failed to upload video to storage' 
              }));
            }

            // 2. Upload cover
            const { error: coverUploadError } = await supabase.storage
              .from('covers')
              .upload(coverName, coverFile.buffer, {
                contentType: coverFile.mimeType,
                cacheControl: 'public, max-age=31536000',
                upsert: false
              });

            if (coverUploadError) {
              console.error('Cover upload failed:', coverUploadError);
              await supabase.storage.from('videos').remove([videoName]);
              return resolve(res.status(500).json({ 
                success: false, 
                error: 'Failed to upload cover image' 
              }));
            }

            // Get public URLs
            const { data: videoUrlData } = supabase.storage
              .from('videos')
              .getPublicUrl(videoName);
              
            const { data: coverUrlData } = supabase.storage
              .from('covers')
              .getPublicUrl(coverName);
            
            const videoPublicUrl = videoUrlData.publicUrl;
            const coverPublicUrl = coverUrlData.publicUrl;

            // 3. Create video record in database
            const videoData = {
              id: videoId,
              user_id: userId,
              title: videoTitle,
              description: description || null,
              video_url: videoPublicUrl,
              cover_url: coverPublicUrl,
              mime_type: videoFile.mimeType,
              size: videoFile.size,
              original_filename: videoFile.filename,
              views: 0,
              created_at: new Date().toISOString()
            };

            const { data: video, error: dbError } = await supabase
              .from('videos')
              .insert(videoData)
              .select()
              .single();

            if (dbError) {
              console.error('Database insert failed:', dbError);
              await supabase.storage.from('videos').remove([videoName]);
              await supabase.storage.from('covers').remove([coverName]);
              
              return resolve(res.status(500).json({ 
                success: false, 
                error: 'Failed to save video metadata'
              }));
            }

            // 4. Update user's video count
            await supabase
              .from('users')
              .update({ 
                video_count: (user.video_count || 0) + 1,
                last_upload: new Date().toISOString()
              })
              .eq('id', userId);

            return resolve(res.status(200).json({
              success: true,
              message: 'Video uploaded successfully',
              video: {
                id: videoId,
                title: videoTitle,
                video_url: videoPublicUrl,
                cover_url: coverPublicUrl,
                description: description,
                views: 0,
                created_at: video.created_at,
                user_id: userId,
                username: user.username
              }
            }));

          } catch (err) {
            console.error('Upload processing error:', err);
            return resolve(res.status(500).json({ 
              success: false, 
              error: 'Upload processing failed'
            }));
          }
        });

        bb.on('error', (err) => {
          console.error('Busboy error:', err);
          resolve(res.status(500).json({ 
            success: false, 
            error: 'Form parsing failed' 
          }));
        });

        req.pipe(bb);
      });

    } else {
      // === UNSUPPORTED CONTENT TYPE ===
      return res.status(400).json({ 
        success: false, 
        error: 'Unsupported Content-Type. Use multipart/form-data or application/json' 
      });
    }

  } catch (err) {
    console.error('Upload handler error:', err);
    return res.status(500).json({ 
      success: false, 
      error: 'Internal server error'
    });
  }
}
