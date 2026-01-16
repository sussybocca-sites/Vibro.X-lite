// pages/api/view-videos.js - UPDATED WITH TAB SUPPORT
import { createClient } from '@supabase/supabase-js';
import cookie from 'cookie';

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  try {
    console.log('👀 View-videos API called, method:', req.method);
    console.log('📊 Query params:', req.query);
    
    let userId = null;
    let userEmail = null;
    
    // Check if user is authenticated
    const cookies = req.headers.cookie ? cookie.parse(req.headers.cookie) : {};
    const sessionToken = cookies['__Host-session_secure'] || cookies.session_secure;
    
    console.log('🔍 Session token present:', !!sessionToken);
    
    if (sessionToken) {
      const { data: session } = await supabase
        .from('sessions')
        .select('user_id, user_email, expires_at')
        .eq('session_token', sessionToken)
        .maybeSingle();

      if (session && new Date(session.expires_at) > new Date()) {
        userId = session.user_id;
        userEmail = session.user_email;
        console.log('✅ User authenticated, ID:', userId, 'Email:', userEmail);
      } else {
        console.log('❌ Session expired or invalid');
      }
    } else {
      console.log('❌ No session token - user is guest');
    }

    // Handle POST: add a new comment
    if (req.method === 'POST') {
      console.log('💬 POST request - adding comment');
      
      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const { videoId } = req.query;
      const { text } = req.body;

      console.log('💬 Comment details - Video ID:', videoId, 'Text length:', text?.length);

      if (!text) return res.status(400).json({ error: 'Comment text required' });
      if (!videoId) return res.status(400).json({ error: 'Video ID required' });

      // Verify video exists
      const { data: video } = await supabase
        .from('videos')
        .select('id, user_id, views')
        .eq('id', videoId)
        .maybeSingle();

      if (!video) return res.status(404).json({ error: 'Video not found' });

      // Get user info for response
      const { data: user } = await supabase
        .from('users')
        .select('id, username, avatar_url, email, profile_picture')
        .eq('id', userId)
        .single();

      // Insert comment
      const { data: newComment, error } = await supabase
        .from('comments')
        .insert({
          user_id: userId,
          video_id: videoId,
          comment_text: text
        })
        .select('*')
        .single();

      if (error) {
        console.error('❌ Comment insert error:', error);
        return res.status(500).json({ error: error.message });
      }

      console.log('✅ Comment posted successfully');
      
      return res.status(200).json({
        id: newComment.id,
        text: newComment.comment_text,
        created_at: newComment.created_at,
        user: {
          ...user,
          avatar_url: user.avatar_url || user.profile_picture
        }
      });
    }

    // Handle GET: list videos with likes and views
    if (req.method === 'GET') {
      console.log('📹 GET request - fetching videos');
      
      const { 
        statsOnly, 
        ids, 
        since, 
        videoId: singleVideoId, 
        incrementViews, 
        sort = 'newest', 
        limit = 12, 
        offset = 0, 
        search,
        view = 'home',  // NEW: 'home', 'trending', 'history', 'liked', 'your-videos', 'watch-later'
        category,
        userId: specificUserId
      } = req.query;
      
      // ========== STATS ONLY MODE (for polling/real-time updates) ==========
      if (statsOnly === 'true' && ids) {
        console.log(`📊 STATS ONLY MODE - Getting stats for videos`);
        
        const videoIds = ids.split(',');
        
        const { data: videos, error: videosError } = await supabase
          .from('videos')
          .select(`
            id,
            views,
            created_at
          `)
          .in('id', videoIds);
        
        if (videosError) {
          console.error('❌ Stats fetch error:', videosError);
          return res.status(500).json({ error: videosError.message });
        }
        
        if (!videos || videos.length === 0) {
          console.log('📊 No videos found');
          return res.status(200).json([]);
        }
        
        console.log(`📊 Found ${videos.length} videos`);
        
        // Get additional stats for each video
        const result = await Promise.all(
          videos.map(async (video) => {
            try {
              // Get like count from likes table
              const { count: likes } = await supabase
                .from('likes')
                .select('*', { count: 'exact', head: true })
                .eq('target_id', video.id)
                .eq('target_type', 'video');
              
              // Check if current user liked this video
              let hasLiked = false;
              if (userEmail) {
                const { data: userLike } = await supabase
                  .from('likes')
                  .select('id')
                  .eq('target_id', video.id)
                  .eq('target_type', 'video')
                  .eq('user_email', userEmail)
                  .maybeSingle();
                hasLiked = !!userLike;
              }
              
              // Get comment count
              const { count: commentCount } = await supabase
                .from('comments')
                .select('*', { count: 'exact', head: true })
                .eq('video_id', video.id);
              
              return {
                id: video.id,
                views: video.views || 0,
                likes: likes || 0,
                hasLiked,
                commentCount: commentCount || 0
              };
            } catch (err) {
              console.error(`❌ Error processing video ${video.id}:`, err.message);
              return {
                id: video.id,
                views: video.views || 0,
                likes: 0,
                hasLiked: false,
                commentCount: 0
              };
            }
          })
        );
        
        console.log(`📊 Returning stats for ${result.length} videos`);
        return res.status(200).json(result);
      }
      
      // ========== SINGLE VIDEO REQUEST ==========
      if (singleVideoId) {
        console.log(`🎬 Single video requested: ${singleVideoId}`);
        
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
            tags,
            ai_generated,
            users (
              id,
              email,
              username,
              avatar_url,
              profile_picture
            )
          `)
          .eq('id', singleVideoId)
          .limit(1);

        if (videosError || !videos || videos.length === 0) {
          console.error('❌ Video not found');
          return res.status(404).json({ error: 'Video not found' });
        }

        const video = videos[0];
        
        // Process the single video
        const result = await processVideoData(video, userEmail);
        
        // INCREMENT VIEW COUNT if requested
        if (incrementViews === 'true') {
          console.log(`📹 Incrementing view count for video ${video.id}`);
          const { data: updatedVideo } = await supabase
            .from('videos')
            .update({ 
              views: (video.views || 0) + 1
            })
            .eq('id', video.id)
            .select('views')
            .single();
          
          if (updatedVideo) {
            result.views = updatedVideo.views;
          }
        }
        
        return res.status(200).json(result);
      }
      
      // ========== ALL VIDEOS REQUEST WITH DIFFERENT VIEWS ==========
      console.log(`📹 Getting videos for view: ${view}`);
      
      // Build query based on parameters
      let query = supabase
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
          tags,
          ai_generated,
          category,
          privacy,
          users (
            id,
            email,
            username,
            avatar_url,
            profile_picture
          )
        `);

      // Apply different filters based on view
      switch(view) {
        case 'home':
          // Default view - show public videos
          query = query.eq('privacy', 'public');
          break;
          
        case 'trending':
          // Trending videos - most views in last 7 days
          const sevenDaysAgo = new Date();
          sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
          
          query = query
            .eq('privacy', 'public')
            .gte('created_at', sevenDaysAgo.toISOString())
            .order('views', { ascending: false });
          break;
          
        case 'history':
          // User's watch history - requires authentication
          if (!userId) {
            return res.status(401).json({ error: 'Authentication required for watch history' });
          }
          
          // We need to join with a watch_history table (we'll create this later)
          // For now, return empty or show recently watched videos from a temporary table
          query = query.eq('privacy', 'public').limit(0);
          break;
          
        case 'liked':
          // User's liked videos - requires authentication
          if (!userId) {
            return res.status(401).json({ error: 'Authentication required for liked videos' });
          }
          
          // Get videos that user has liked
          const { data: likedVideos } = await supabase
            .from('likes')
            .select('target_id')
            .eq('user_email', userEmail)
            .eq('target_type', 'video');
          
          if (likedVideos && likedVideos.length > 0) {
            const likedVideoIds = likedVideos.map(like => like.target_id);
            query = query.in('id', likedVideoIds).eq('privacy', 'public');
          } else {
            query = query.limit(0); // No liked videos
          }
          break;
          
        case 'your-videos':
          // User's own videos - requires authentication
          if (!userId) {
            return res.status(401).json({ error: 'Authentication required for your videos' });
          }
          
          query = query.eq('user_id', userId);
          // Show all videos including private ones for the owner
          break;
          
        case 'watch-later':
          // User's watch later list - requires authentication
          if (!userId) {
            return res.status(401).json({ error: 'Authentication required for watch later' });
          }
          
          // We need a watch_later table (we'll create this later)
          query = query.eq('privacy', 'public').limit(0);
          break;
          
        default:
          // Default to home view
          query = query.eq('privacy', 'public');
      }
      
      // Apply category filter if specified
      if (category && category !== 'all') {
        query = query.eq('category', category);
      }
      
      // Apply search filter
      if (search) {
        query = query.or(`title.ilike.%${search}%,description.ilike.%${search}%,users.username.ilike.%${search}%`);
      }

      // Apply sorting (if not already sorted by trending)
      if (view !== 'trending') {
        switch (sort) {
          case 'popular':
            query = query.order('views', { ascending: false });
            break;
          case 'oldest':
            query = query.order('created_at', { ascending: true });
            break;
          case 'newest':
          default:
            query = query.order('created_at', { ascending: false });
            break;
        }
      }

      // Apply pagination
      if (limit && offset) {
        query = query.range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
      }

      const { data: videos, error: videosError } = await query;

      if (videosError) {
        console.error('❌ Videos fetch error:', videosError);
        return res.status(500).json({ error: videosError.message });
      }
      
      if (!videos || videos.length === 0) {
        console.log('📭 No videos found');
        return res.status(200).json([]);
      }

      console.log(`📹 Found ${videos.length} videos`);
      
      // Build response with additional data
      const result = await Promise.all(
        videos.map(async (video) => {
          return await processVideoData(video, userEmail);
        })
      );

      console.log('✅ Returning', result.length, 'videos');
      return res.status(200).json(result);
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('❌❌❌ Video API crash:', err);
    console.error('❌❌❌ Error stack:', err.stack);
    
    res.status(500).json({ 
      error: 'Internal server error',
      message: err.message
    });
  }
}

// Helper function to process video data
async function processVideoData(video, userEmail) {
  try {
    console.log(`📹 Processing video: ${video.title || 'Untitled'} (${video.id})`);
    
    // Get like count from likes table
    const { count: likes } = await supabase
      .from('likes')
      .select('*', { count: 'exact', head: true })
      .eq('target_id', video.id)
      .eq('target_type', 'video');

    // Check if current user liked this video
    let hasLiked = false;
    if (userEmail) {
      const { data: userLike } = await supabase
        .from('likes')
        .select('id')
        .eq('target_id', video.id)
        .eq('target_type', 'video')
        .eq('user_email', userEmail)
        .maybeSingle();
      hasLiked = !!userLike;
    }

    // Handle video and cover URLs
    let videoUrl = video.video_url;
    let coverUrl = video.cover_url;

    // If URLs are relative paths, create public URLs
    if (videoUrl && !videoUrl.startsWith('http') && !videoUrl.startsWith('blob:')) {
      try {
        console.log(`🔄 Generating video URL for: ${videoUrl}`);
        const { data: publicUrlData } = supabase.storage
          .from('videos')
          .getPublicUrl(videoUrl);
        videoUrl = publicUrlData.publicUrl;
        console.log(`✅ Video URL generated`);
      } catch (error) {
        console.error('❌ Error creating video URL:', error);
        // Fallback to the original URL
      }
    }
    
    if (coverUrl && !coverUrl.startsWith('http') && !coverUrl.startsWith('blob:')) {
      try {
        console.log(`🔄 Generating cover URL for: ${coverUrl}`);
        const { data: publicUrlData } = supabase.storage
          .from('covers')
          .getPublicUrl(coverUrl);
        coverUrl = publicUrlData.publicUrl;
        console.log(`✅ Cover URL generated`);
      } catch (error) {
        console.error('❌ Error creating cover URL:', error);
        // Use a better placeholder
        coverUrl = 'https://images.unsplash.com/photo-1611605698335-8b1569810435?w=800&h=450&fit=crop';
      }
    }

    // Get comments with user info
    const { data: comments } = await supabase
      .from('comments')
      .select(`
        id, 
        user_id, 
        video_id, 
        comment_text, 
        created_at, 
        edited_at,
        users (
          id,
          username,
          email,
          avatar_url,
          profile_picture
        )
      `)
      .eq('video_id', video.id)
      .order('created_at', { ascending: true })
      .limit(50); // Limit comments for performance

    // Process comments to include user data
    const processedComments = (comments || []).map(comment => {
      // Get user data from comment
      const userData = comment.users || {};
      
      return {
        id: comment.id,
        text: comment.comment_text,
        created_at: comment.created_at,
        edited_at: comment.edited_at,
        user: {
          id: userData.id,
          username: userData.username || 'Anonymous',
          email: userData.email,
          avatar_url: userData.avatar_url || userData.profile_picture || `https://ui-avatars.com/api/?name=${encodeURIComponent(userData.username || 'User')}&background=random`
        }
      };
    });

    // Process user data
    const userData = video.users || {};
    const processedUser = {
      id: userData.id,
      email: userData.email,
      username: userData.username || userData.email?.split('@')[0] || 'User',
      avatar_url: userData.avatar_url || userData.profile_picture || `https://ui-avatars.com/api/?name=${encodeURIComponent(userData.username || userData.email || 'User')}&background=random`
    };

    // Calculate duration placeholder (you might want to store actual duration in database)
    // For now, we'll use a random duration between 1-10 minutes
    const duration = Math.floor(Math.random() * 600) + 60; // 1-10 minutes in seconds

    // Return the data with EXACT property names the frontend expects
    return {
      id: video.id,
      title: video.title || 'Untitled Video',
      description: video.description || '',
      likes: likes || 0,
      hasLiked,
      views: video.views || 0,
      uploaded_at: video.created_at,
      video_url: videoUrl,  // Frontend expects video_url
      cover_url: coverUrl || 'https://images.unsplash.com/photo-1611605698335-8b1569810435?w=800&h=450&fit=crop',  // Frontend expects cover_url
      duration: duration,
      user: processedUser,
      comments: processedComments,
      tags: video.tags || [],
      category: video.category || 'other',
      privacy: video.privacy || 'public',
      ai_generated: video.ai_generated || false,
      mime_type: video.mime_type,
      size: video.size,
      original_filename: video.original_filename,
      created_at: video.created_at  // Add created_at for consistency
    };
  } catch (err) {
    console.error(`❌ Error in processVideoData for video ${video.id}:`, err.message);
    
    // Return basic video data even if processing fails
    const userData = video.users || {};
    return {
      id: video.id,
      title: video.title || 'Untitled Video',
      description: video.description || '',
      likes: 0,
      hasLiked: false,
      views: video.views || 0,
      uploaded_at: video.created_at,
      video_url: video.video_url,
      cover_url: video.cover_url || 'https://images.unsplash.com/photo-1611605698335-8b1569810435?w=800&h=450&fit=crop',
      duration: 180,
      user: {
        id: userData.id,
        email: userData.email,
        username: userData.username || 'User',
        avatar_url: userData.avatar_url || userData.profile_picture || `https://ui-avatars.com/api/?name=${encodeURIComponent(userData.username || userData.email || 'User')}&background=random`
      },
      comments: [],
      tags: video.tags || [],
      category: video.category || 'other',
      privacy: video.privacy || 'public',
      ai_generated: video.ai_generated || false,
      created_at: video.created_at
    };
  }
}
