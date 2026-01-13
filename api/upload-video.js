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
  console.log('=== UPLOAD VIDEO API CALLED ===');
  console.log('Method:', req.method);
  console.log('Content-Type:', req.headers['content-type']);
  console.log('Origin:', req.headers.origin);
  
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    console.log('✅ CORS preflight request');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    console.error('❌ Method not allowed:', req.method);
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    console.log('🔍 Starting upload process...');
    
    // Verify session
    const cookies = cookie.parse(req.headers.cookie || '');
    const sessionToken = cookies['__Host-session_secure'] || cookies.session_secure;

    console.log('🔍 Session token present:', !!sessionToken);
    if (sessionToken) {
      console.log('🔍 Session token length:', sessionToken.length);
    }

    if (!sessionToken) {
      console.error('❌ No session token found in cookies');
      console.log('❌ All cookies:', Object.keys(cookies));
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }

    // Get session
    console.log('🔍 Checking session in database...');
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('user_email, expires_at')
      .eq('session_token', sessionToken)
      .maybeSingle();

    if (sessionError) {
      console.error('❌ Session database error:', sessionError);
      return res.status(401).json({ success: false, error: 'Session expired or invalid' });
    }

    if (!session) {
      console.error('❌ No session found in database for token');
      return res.status(401).json({ success: false, error: 'Session expired or invalid' });
    }

    console.log('✅ Session found for user:', session.user_email);
    console.log('🔍 Session expires at:', session.expires_at);

    if (new Date(session.expires_at) < new Date()) {
      console.error('❌ Session expired');
      await supabase.from('sessions').delete().eq('session_token', sessionToken);
      return res.status(401).json({ success: false, error: 'Session expired' });
    }

    // Get user
    console.log('🔍 Fetching user data...');
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, email, username, video_count')
      .eq('email', session.user_email)
      .maybeSingle();

    if (userError) {
      console.error('❌ User database error:', userError);
      return res.status(401).json({ success: false, error: 'User not found' });
    }

    if (!user) {
      console.error('❌ User not found in database');
      return res.status(401).json({ success: false, error: 'User not found' });
    }

    console.log('✅ User authenticated:', user.email, 'ID:', user.id);
    const userId = user.id;
    
    // Check Content-Type to determine how to handle the request
    const contentType = req.headers['content-type'] || '';
    console.log('🔍 Content-Type detected:', contentType);
    
    if (contentType.includes('application/json')) {
      console.log('📦 Handling JSON request (signed URL system)');
      // ===== JSON REQUEST (new signed URL system) =====
      let body = '';
      
      req.on('data', chunk => {
        body += chunk.toString();
      });
      
      req.on('end', async () => {
        try {
          console.log('📦 JSON body received:', body.substring(0, 500) + '...');
          const data = JSON.parse(body);
          const { videoInfo, fileInfo, action } = data;
          
          console.log('📦 Action:', action);
          console.log('📦 Video info:', videoInfo);
          console.log('📦 File info present:', !!fileInfo);
          
          if (action === 'prepare') {
            // === STEP 1: PREPARE UPLOAD (Generate signed URLs) ===
            
            if (!videoInfo || !videoInfo.title) {
              console.error('❌ Missing video title');
              return res.status(400).json({ 
                success: false, 
                error: 'Video title is required' 
              });
            }

            if (!fileInfo || !fileInfo.video || !fileInfo.video.name || !fileInfo.video.type) {
              console.error('❌ Missing video file info');
              return res.status(400).json({ 
                success: false, 
                error: 'Video file information is required' 
              });
            }

            console.log('📦 Video file type:', fileInfo.video.type);
            console.log('📦 Video file name:', fileInfo.video.name);
            console.log('📦 Video file size:', fileInfo.video.size);

            if (!ALLOWED_VIDEO_TYPES.includes(fileInfo.video.type)) {
              console.error('❌ Invalid video format:', fileInfo.video.type);
              return res.status(400).json({ 
                success: false, 
                error: `Invalid video format: ${fileInfo.video.type}` 
              });
            }

            if (fileInfo.cover && !ALLOWED_IMAGE_TYPES.includes(fileInfo.cover.type)) {
              console.error('❌ Invalid cover format:', fileInfo.cover.type);
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

            console.log('📦 Generated video filename:', videoName);
            console.log('📦 Generated cover filename:', coverName);

            // Generate signed URLs
            console.log('🔑 Generating signed URL for video...');
            const videoSignedUrl = await supabase.storage
              .from('videos')
              .createSignedUploadUrl(videoName);

            if (videoSignedUrl.error) {
              console.error('❌ Failed to generate video signed URL:', videoSignedUrl.error);
              return res.status(500).json({ 
                success: false, 
                error: 'Failed to generate upload URL' 
              });
            }

            console.log('✅ Video signed URL generated');

            let coverSignedUrl = null;
            if (coverName) {
              console.log('🔑 Generating signed URL for cover...');
              const coverUrlResult = await supabase.storage
                .from('covers')
                .createSignedUploadUrl(coverName);
              
              if (!coverUrlResult.error) {
                coverSignedUrl = coverUrlResult.data;
                console.log('✅ Cover signed URL generated');
              } else {
                console.warn('⚠️ Failed to generate cover signed URL:', coverUrlResult.error);
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

            console.log('💾 Creating video record in database...');
            const { data: video, error: dbError } = await supabase
              .from('videos')
              .insert(videoData)
              .select()
              .single();

            if (dbError) {
              console.error('❌ Database insert failed:', dbError);
              return res.status(500).json({ 
                success: false, 
                error: 'Failed to save video metadata'
              });
            }

            console.log('✅ Video record created:', videoId);
            console.log('✅ Returning signed URLs to client');

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
            console.log('📦 Completing upload...');
            const { videoId, success, error: uploadError } = data;
            
            if (!videoId) {
              console.error('❌ Missing video ID');
              return res.status(400).json({ 
                success: false, 
                error: 'Video ID is required' 
              });
            }

            console.log('📦 Video ID:', videoId);
            console.log('📦 Success flag:', success);

            if (!success) {
              console.error('❌ Upload failed on client side:', uploadError);
              await supabase.from('videos').delete().eq('id', videoId);
              return res.status(400).json({ 
                success: false, 
                error: uploadError || 'Upload failed' 
              });
            }

            // Get the video
            console.log('🔍 Fetching video from database...');
            const { data: video, error: videoFetchError } = await supabase
              .from('videos')
              .select('user_id, original_filename')
              .eq('id', videoId)
              .single();

            if (videoFetchError || !video) {
              console.error('❌ Video not found in database:', videoFetchError);
              return res.status(404).json({ success: false, error: 'Video not found' });
            }

            // Reconstruct filenames
            const videoName = `${video.user_id}/${videoId}.${video.original_filename.split('.').pop().toLowerCase()}`;
            const coverName = `${video.user_id}/${videoId}.jpg`;

            console.log('🔗 Getting public URLs...');
            console.log('🔗 Video path:', videoName);
            console.log('🔗 Cover path:', coverName);

            // Get public URLs
            const { data: videoUrlData } = supabase.storage
              .from('videos')
              .getPublicUrl(videoName);
            
            const { data: coverUrlData } = supabase.storage
              .from('covers')
              .getPublicUrl(coverName);
            
            const videoPublicUrl = videoUrlData.publicUrl;
            const coverPublicUrl = coverUrlData.publicUrl;

            console.log('🔗 Video URL:', videoPublicUrl);
            console.log('🔗 Cover URL:', coverPublicUrl);

            // Update video with real URLs
            console.log('💾 Updating video with public URLs...');
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
              console.error('❌ Failed to update video URLs:', updateError);
              return res.status(500).json({ 
                success: false, 
                error: 'Failed to update video metadata' 
              });
            }

            // Update user's video count
            console.log('👤 Updating user video count...');
            await supabase
              .from('users')
              .update({ 
                video_count: (user.video_count || 0) + 1,
                last_upload: new Date().toISOString()
              })
              .eq('id', userId);

            console.log('✅ Upload completed successfully!');
            return res.status(200).json({
              success: true,
              message: 'Video uploaded successfully',
              action: 'complete',
              video: updatedVideo
            });

          } else {
            console.error('❌ Invalid action:', action);
            return res.status(400).json({ 
              success: false, 
              error: 'Invalid action' 
            });
          }
        } catch (err) {
          console.error('❌ JSON parsing error:', err);
          console.error('❌ Error stack:', err.stack);
          return res.status(400).json({ 
            success: false, 
            error: 'Invalid JSON: ' + err.message 
          });
        }
      });
      
      // IMPORTANT: Return here to prevent the handler from ending prematurely
      return;
      
    } else if (contentType.includes('multipart/form-data')) {
      console.log('📁 Handling multipart/form-data request (legacy system)');
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
          console.log('📝 Form field:', name, '=', value.substring(0, 100));
          if (name === 'title') videoTitle = value.trim();
          if (name === 'description') description = value.trim();
        });

        bb.on('file', (name, file, info) => {
          const { filename, mimeType } = info;
          console.log('📁 File upload:', name, filename, mimeType);
          const chunks = [];
          
          file.on('data', (chunk) => {
            chunks.push(chunk);
          });

          file.on('end', () => {
            const buffer = Buffer.concat(chunks);
            console.log('📁 File received:', name, 'size:', buffer.length, 'bytes');
            
            if (name === 'video') {
              if (!ALLOWED_VIDEO_TYPES.includes(mimeType)) {
                console.error('❌ Invalid video format:', mimeType);
                file.resume();
                return resolve(res.status(400).json({ 
                  success: false, 
                  error: `Invalid video format: ${mimeType}` 
                }));
              }
              
              if (buffer.length > MAX_FILE_SIZE) {
                console.error('❌ Video too large:', buffer.length, 'bytes');
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
                console.error('❌ Invalid image format:', mimeType);
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
            console.error('❌ File stream error:', err);
            file.resume();
            resolve(res.status(500).json({ 
              success: false, 
              error: 'File upload failed' 
            }));
          });
        });

        bb.on('finish', async () => {
          try {
            console.log('✅ Form parsing complete');
            console.log('📝 Title:', videoTitle);
            console.log('📝 Description length:', description.length);
            console.log('📁 Video file present:', !!videoFile);
            console.log('📁 Cover file present:', !!coverFile);

            if (!videoFile) {
              console.error('❌ No video uploaded');
              return resolve(res.status(400).json({ 
                success: false, 
                error: 'No video uploaded' 
              }));
            }
            
            if (!coverFile) {
              console.error('❌ No cover image uploaded');
              return resolve(res.status(400).json({ 
                success: false, 
                error: 'Cover image is required' 
              }));
            }
            
            if (!videoTitle || videoTitle.length < 3) {
              console.error('❌ Invalid title:', videoTitle);
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

            console.log('📦 Generated video ID:', videoId);
            console.log('📁 Video storage path:', videoName);
            console.log('📁 Cover storage path:', coverName);

            // 1. Upload video to storage
            console.log('☁️ Uploading video to Supabase storage...');
            const { error: videoUploadError } = await supabase.storage
              .from('videos')
              .upload(videoName, videoFile.buffer, {
                contentType: videoFile.mimeType,
                cacheControl: 'public, max-age=31536000',
                upsert: false
              });

            if (videoUploadError) {
              console.error('❌ Video upload failed:', videoUploadError);
              return resolve(res.status(500).json({ 
                success: false, 
                error: 'Failed to upload video to storage' 
              }));
            }

            console.log('✅ Video uploaded to storage');

            // 2. Upload cover
            console.log('☁️ Uploading cover to Supabase storage...');
            const { error: coverUploadError } = await supabase.storage
              .from('covers')
              .upload(coverName, coverFile.buffer, {
                contentType: coverFile.mimeType,
                cacheControl: 'public, max-age=31536000',
                upsert: false
              });

            if (coverUploadError) {
              console.error('❌ Cover upload failed:', coverUploadError);
              await supabase.storage.from('videos').remove([videoName]);
              return resolve(res.status(500).json({ 
                success: false, 
                error: 'Failed to upload cover image' 
              }));
            }

            console.log('✅ Cover uploaded to storage');

            // Get public URLs
            const { data: videoUrlData } = supabase.storage
              .from('videos')
              .getPublicUrl(videoName);
              
            const { data: coverUrlData } = supabase.storage
              .from('covers')
              .getPublicUrl(coverName);
            
            const videoPublicUrl = videoUrlData.publicUrl;
            const coverPublicUrl = coverUrlData.publicUrl;

            console.log('🔗 Video URL:', videoPublicUrl);
            console.log('🔗 Cover URL:', coverPublicUrl);

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

            console.log('💾 Creating database record...');
            const { data: video, error: dbError } = await supabase
              .from('videos')
              .insert(videoData)
              .select()
              .single();

            if (dbError) {
              console.error('❌ Database insert failed:', dbError);
              await supabase.storage.from('videos').remove([videoName]);
              await supabase.storage.from('covers').remove([coverName]);
              
              return resolve(res.status(500).json({ 
                success: false, 
                error: 'Failed to save video metadata'
              }));
            }

            // 4. Update user's video count
            console.log('👤 Updating user video count...');
            await supabase
              .from('users')
              .update({ 
                video_count: (user.video_count || 0) + 1,
                last_upload: new Date().toISOString()
              })
              .eq('id', userId);

            console.log('✅ Upload completed successfully!');
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
            console.error('❌ Upload processing error:', err);
            console.error('❌ Error stack:', err.stack);
            return resolve(res.status(500).json({ 
              success: false, 
              error: 'Upload processing failed: ' + err.message
            }));
          }
        });

        bb.on('error', (err) => {
          console.error('❌ Busboy error:', err);
          console.error('❌ Error stack:', err.stack);
          resolve(res.status(500).json({ 
            success: false, 
            error: 'Form parsing failed: ' + err.message 
          }));
        });

        console.log('📥 Piping request to busboy...');
        req.pipe(bb);
      });

    } else {
      console.error('❌ Unsupported Content-Type:', contentType);
      return res.status(400).json({ 
        success: false, 
        error: 'Unsupported Content-Type. Use multipart/form-data or application/json' 
      });
    }

  } catch (err) {
    console.error('❌❌❌ UPLOAD HANDLER FATAL ERROR:', err);
    console.error('❌❌❌ Error stack:', err.stack);
    return res.status(500).json({ 
      success: false, 
      error: 'Internal server error: ' + err.message
    });
  }
}
