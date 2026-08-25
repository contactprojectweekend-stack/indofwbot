import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { pool } from './db';
import { bot } from './bot';
import path from 'path';

const router = Router();
const JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'secret';

export async function seedAdmin() {
  try {
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_vip BOOLEAN DEFAULT FALSE').catch(() => {});
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_dummy BOOLEAN DEFAULT FALSE').catch(() => {});
    await pool.query('ALTER TABLE reports ALTER COLUMN reporter_id DROP NOT NULL').catch(() => {});

    const email = 'contact.projectweekend@gmail.com';
    const defaultPass = 'Indonesia';
    const check = await pool.query('SELECT id FROM admins WHERE email = $1', [email]);
    if (check.rowCount === 0) {
      const hash = await bcrypt.hash(defaultPass, 12);
      await pool.query(
        `INSERT INTO admins (email, password_hash, role) VALUES ($1, $2, 'SUPER_ADMIN')`,
        [email, hash]
      );
      console.log('✅ Akun Admin disiapkan: contact.projectweekend@gmail.com');
    }
  } catch (e) {
    console.error('Error seedAdmin:', e);
  }
}

async function recordAudit(adminId: string, action: string, targetType: string, targetId: string, ip: string, meta: any) {
  try {
    await pool.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, ip_address, metadata) VALUES ($1, $2, $3, $4, $5, $6)`,
      [adminId, action, targetType, targetId, ip, JSON.stringify(meta)]
    );
  } catch (e) {
    console.error('Gagal mencatat audit log:', e);
  }
}

function requireAdmin(req: any, res: any, next: any) {
  const token = req.cookies?.admin_token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Akses ditolak' });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Sesi kedaluwarsa' });
  }
}

// 1. LOGIN ADMIN
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const ip = req.ip || '';
  const result = await pool.query('SELECT * FROM admins WHERE email = $1 AND is_active = TRUE', [email]);
  if (result.rowCount === 0) return res.status(401).json({ error: 'Kredensial tidak valid' });

  const admin = result.rows[0];
  const valid = await bcrypt.compare(password, admin.password_hash);
  if (!valid) return res.status(401).json({ error: 'Kredensial tidak valid' });

  const token = jwt.sign({ id: admin.id, email: admin.email, role: admin.role }, JWT_SECRET, { expiresIn: '8h' });
  res.cookie('admin_token', token, { httpOnly: true });
  await recordAudit(admin.id, 'LOGIN', 'ADMIN', admin.id, ip, { email });

  res.json({ success: true, token });
});

// 2. DAFTAR PENGGUNA
router.get('/users', requireAdmin, async (req: any, res) => {
  const data = await pool.query(`
    SELECT u.*, 
      (SELECT COUNT(*) FROM likes l WHERE l.to_user_id = u.id) AS likes_count,
      (SELECT COUNT(*) FROM super_likes sl WHERE sl.to_user_id = u.id) AS superlikes_count,
      COALESCE(
        (SELECT json_agg(json_build_object('id', up.id, 'storage_path', up.storage_path, 'file_url', up.file_url, 'is_primary', up.is_primary))
         FROM user_photos up WHERE up.user_id = u.id),
        '[]'::json
      ) AS photos
    FROM users u 
    ORDER BY u.created_at DESC 
    LIMIT 100
  `);
  await recordAudit(req.admin.id, 'VIEW_USERS', 'USER_LIST', 'ALL', req.ip || '', {});
  res.json(data.rows);
});

// 3. TOGGLE VIP STATUS
router.post('/users/:id/toggle-vip', requireAdmin, async (req: any, res) => {
  try {
    const { id } = req.params;
    const userRes = await pool.query('SELECT is_vip, display_name FROM users WHERE id = $1', [id]);
    if (userRes.rowCount === 0) return res.status(404).json({ error: 'Pengguna tidak ditemukan' });

    const newVipStatus = !userRes.rows[0].is_vip;
    await pool.query('UPDATE users SET is_vip = $1 WHERE id = $2', [newVipStatus, id]);

    await recordAudit(req.admin.id, 'TOGGLE_VIP', 'USERS', id, req.ip || '', { newVipStatus });
    res.json({ success: true, is_vip: newVipStatus, message: `Status VIP untuk ${userRes.rows[0].display_name} berhasil ${newVipStatus ? 'diaktifkan ⭐' : 'dinonaktifkan'}.` });
  } catch (err: any) {
    res.status(500).json({ error: 'Gagal mengubah status VIP: ' + err.message });
  }
});

// 4. MONITORING PERCAKAPAN
router.get('/grouped-conversations', requireAdmin, async (req: any, res) => {
  try {
    const query = `
      SELECT 
        c.id AS connection_id,
        c.connection_type,
        c.created_at AS connection_created_at,
        u1.id AS user1_id, u1.display_name AS user1_name, u1.username AS user1_username, u1.is_vip AS user1_vip, u1.telegram_id AS user1_tg,
        u2.id AS user2_id, u2.display_name AS user2_name, u2.username AS user2_username, u2.is_vip AS user2_vip, u2.telegram_id AS user2_tg,
        COUNT(m.id) AS total_messages,
        MAX(m.created_at) AS last_message_at,
        COALESCE(
          json_agg(
            json_build_object(
              'id', m.id,
              'sender_id', m.sender_id,
              'sender_name', CASE WHEN m.sender_id = u1.id THEN u1.display_name ELSE u2.display_name END,
              'message_type', m.message_type,
              'message_text', m.message_text,
              'media_url', m.media_url,
              'created_at', m.created_at
            ) ORDER BY m.created_at ASC
          ) FILTER (WHERE m.id IS NOT NULL),
          '[]'::json
        ) AS messages
      FROM connections c
      JOIN users u1 ON c.user_1_id = u1.id
      JOIN users u2 ON c.user_2_id = u2.id
      LEFT JOIN messages m ON m.connection_id = c.id
      GROUP BY c.id, u1.id, u2.id
      ORDER BY last_message_at DESC NULLS LAST, c.created_at DESC
      LIMIT 50
    `;

    const data = await pool.query(query);
    await recordAudit(req.admin.id, 'VIEW_GROUPED_CONVERSATIONS', 'ROOMS', 'ALL', req.ip || '', {});
    res.json(data.rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Gagal mengambil percakapan: ' + err.message });
  }
});

// 5. MONITORING LAPORAN PENGGUNA (REPORTS)
router.get('/reports', requireAdmin, async (req: any, res) => {
  try {
    const query = `
      SELECT 
        r.*,
        u1.display_name AS reporter_name, u1.username AS reporter_username, u1.telegram_id AS reporter_tg,
        u2.display_name AS reported_name, u2.username AS reported_username, u2.telegram_id AS reported_tg,
        (SELECT file_url FROM user_photos up WHERE up.user_id = u2.id AND up.is_primary = true LIMIT 1) AS reported_photo
      FROM reports r
      LEFT JOIN users u1 ON r.reporter_id = u1.id
      JOIN users u2 ON r.reported_user_id = u2.id
      ORDER BY r.created_at DESC
      LIMIT 100
    `;
    const data = await pool.query(query);
    await recordAudit(req.admin.id, 'VIEW_REPORTS', 'REPORTS', 'ALL', req.ip || '', {});
    res.json(data.rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Gagal mengambil data laporan: ' + err.message });
  }
});

// 6. TANDAI LAPORAN SELESAI
router.post('/reports/:id/resolve', requireAdmin, async (req: any, res) => {
  try {
    const { id } = req.params;
    await pool.query("UPDATE reports SET status = 'RESOLVED', resolved_at = NOW() WHERE id = $1", [id]);
    await recordAudit(req.admin.id, 'RESOLVE_REPORT', 'REPORTS', id, req.ip || '', {});
    res.json({ success: true, message: 'Laporan ditandai selesai.' });
  } catch (err: any) {
    res.status(500).json({ error: 'Gagal memproses laporan: ' + err.message });
  }
});

// 7. HAPUS LAPORAN
router.delete('/reports/:id', requireAdmin, async (req: any, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM reports WHERE id = $1', [id]);
    await recordAudit(req.admin.id, 'DELETE_REPORT', 'REPORTS', id, req.ip || '', {});
    res.json({ success: true, message: 'Laporan berhasil dihapus.' });
  } catch (err: any) {
    res.status(500).json({ error: 'Gagal menghapus laporan: ' + err.message });
  }
});

// 8. HAPUS SATU ROOM MATCH PERCAKAPAN
router.delete('/conversations/room/:connectionId', requireAdmin, async (req: any, res) => {
  try {
    const { connectionId } = req.params;
    await pool.query('DELETE FROM messages WHERE connection_id = $1', [connectionId]);
    await pool.query('DELETE FROM connections WHERE id = $1', [connectionId]);

    await recordAudit(req.admin.id, 'DELETE_ROOM_CONVERSATION', 'ROOMS', connectionId, req.ip || '', {});
    res.json({ success: true, message: 'Riwayat percakapan dan room match berhasil dihapus dari dashboard.' });
  } catch (err: any) {
    res.status(500).json({ error: 'Gagal menghapus percakapan: ' + err.message });
  }
});

// 9. BERSIHKAN SEMUA RIWAYAT PERCAKAPAN
router.delete('/conversations/clear-all', requireAdmin, async (req: any, res) => {
  try {
    await pool.query('DELETE FROM messages');
    await pool.query('DELETE FROM connections');

    await recordAudit(req.admin.id, 'CLEAR_ALL_ROOM_CONVERSATIONS', 'ROOMS', 'ALL', req.ip || '', {});
    res.json({ success: true, message: 'Semua riwayat percakapan dan room match telah dibersihkan.' });
  } catch (err: any) {
    res.status(500).json({ error: 'Gagal membersihkan percakapan: ' + err.message });
  }
});

// 10. GENERATE 5 DUMMY USERS RANDOM OTOMATIS
router.post('/generate-random-dummies', requireAdmin, async (req: any, res) => {
  try {
    const dummySets = [
      {
        name: 'Amanda Putri',
        gender: 'wanita',
        age: 23,
        photos: [
          'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=600',
          'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=600',
          'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=600'
        ]
      },
      {
        name: 'Dimas Aditya',
        gender: 'pria',
        age: 26,
        photos: [
          'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=600',
          'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=600',
          'https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?w=600'
        ]
      },
      {
        name: 'Jessica Tan',
        gender: 'wanita',
        age: 25,
        photos: [
          'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=600',
          'https://images.unsplash.com/photo-1529626455594-4ff0802cfb7e?w=600',
          'https://images.unsplash.com/photo-1488426862026-3ee34a7d66df?w=600'
        ]
      },
      {
        name: 'Kevin Sanjaya',
        gender: 'pria',
        age: 27,
        photos: [
          'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=600',
          'https://images.unsplash.com/photo-1496345875659-11f7dd282d1d?w=600',
          'https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?w=600'
        ]
      },
      {
        name: 'Clara Wijaya',
        gender: 'wanita',
        age: 22,
        photos: [
          'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=600',
          'https://images.unsplash.com/photo-1508214751196-bcfd4ca60f91?w=600',
          'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=600'
        ]
      }
    ];

    const allGoals = ['FWB', 'ONS', 'Virtual'];
    const allPrefs = [
      ['pria'],
      ['wanita'],
      ['pria', 'wanita'],
      ['pria', 'wanita', 'non-biner', 'lainnya', 'tidak_disebutkan']
    ];

    for (const d of dummySets) {
      const fakeTgId = 999000000 + Math.floor(Math.random() * 999999);
      const cleanUsername = `user_${fakeTgId}`;
      const randomGoals = allGoals.filter(() => Math.random() > 0.3);
      const finalGoals = randomGoals.length > 0 ? randomGoals : ['FWB'];
      const randomPrefs = allPrefs[Math.floor(Math.random() * allPrefs.length)];
      const isVip = Math.random() > 0.5;

      const userRes = await pool.query(
        `INSERT INTO users (telegram_id, username, display_name, age, gender, gender_preferences, relationship_goals, profile_completed, is_active, is_vip, is_dummy)
         VALUES ($1, $2, $3, $4, $5::gender_type, $6::gender_type[], $7::goal_type[], TRUE, TRUE, $8, TRUE)
         RETURNING id`,
        [fakeTgId, cleanUsername, d.name, d.age, d.gender, randomPrefs, finalGoals, isVip]
      );

      const newUserId = userRes.rows[0].id;

      for (let i = 0; i < d.photos.length; i++) {
        await pool.query(
          `INSERT INTO user_photos (user_id, storage_path, file_url, is_primary) VALUES ($1, $2, $3, $4)`,
          [newUserId, d.photos[i], d.photos[i], i === 0]
        );
      }
    }

    await recordAudit(req.admin.id, 'GENERATE_5_RANDOM_DUMMIES', 'USERS', '5_USERS', req.ip || '', {});
    res.json({ success: true, message: '5 Dummy User acak berhasil dibuat lengkap dengan foto, preferensi, dan tujuan hubungan random!' });
  } catch (err: any) {
    res.status(500).json({ error: 'Gagal membuat dummy acak: ' + err.message });
  }
});

// 11. PROXY FOTO & MEDIA
router.get('/photo-view/:id', async (req, res) => {
  try {
    const photo = await pool.query('SELECT storage_path, file_url FROM user_photos WHERE id = $1', [req.params.id]);
    if (photo.rowCount === 0) return res.status(404).send('Foto tidak ditemukan');

    const { storage_path, file_url } = photo.rows[0];

    if (file_url.startsWith('http') && !file_url.includes('api.telegram.org')) {
      return res.redirect(file_url);
    }

    try {
      const freshLink = await bot.telegram.getFileLink(storage_path);
      return res.redirect(freshLink.href);
    } catch {
      return res.redirect(file_url);
    }
  } catch (err) {
    res.status(500).send('Gagal memuat foto');
  }
});

router.get('/media-proxy', async (req, res) => {
  try {
    const fileId = req.query.file_id as string;
    if (!fileId) return res.status(400).send('No file_id');
    if (fileId.startsWith('http')) return res.redirect(fileId);

    const freshLink = await bot.telegram.getFileLink(fileId);
    return res.redirect(freshLink.href);
  } catch {
    res.status(404).send('Media unavailable');
  }
});

// 12. INPUT MANUAL USER / DUMMY
router.post('/create-dummy-user', requireAdmin, async (req: any, res) => {
  try {
    const { display_name, username, age, gender, gender_preferences, relationship_goals, photos, is_vip } = req.body;

    if (!display_name || !age || !gender || !gender_preferences || !relationship_goals || !photos) {
      return res.status(400).json({ error: 'Semua bidang wajib diisi.' });
    }

    const ageNum = parseInt(age, 10);
    const photoList: string[] = Array.isArray(photos) ? photos.map((p: string) => p.trim()).filter((p: string) => p.length > 0) : [];

    let finalPrefs: string[] = Array.isArray(gender_preferences) ? gender_preferences : [gender_preferences];
    if (finalPrefs.includes('Semua')) {
      finalPrefs = ['pria', 'wanita', 'non-biner', 'lainnya', 'tidak_disebutkan'];
    }

    const fakeTgId = 999000000 + Math.floor(Math.random() * 999999);
    const cleanUsername = username ? username.replace('@', '').trim() : `user_${fakeTgId}`;

    const userRes = await pool.query(
      `INSERT INTO users (telegram_id, username, display_name, age, gender, gender_preferences, relationship_goals, profile_completed, is_active, is_vip, is_dummy)
       VALUES ($1, $2, $3, $4, $5::gender_type, $6::gender_type[], $7::goal_type[], TRUE, TRUE, $8, TRUE)
       RETURNING id`,
      [fakeTgId, cleanUsername, display_name, ageNum, gender, finalPrefs, relationship_goals, is_vip === true]
    );

    const newUserId = userRes.rows[0].id;

    for (let i = 0; i < photoList.length; i++) {
      await pool.query(
        `INSERT INTO user_photos (user_id, storage_path, file_url, is_primary) VALUES ($1, $2, $3, $4)`,
        [newUserId, photoList[i], photoList[i], i === 0]
      );
    }

    await recordAudit(req.admin.id, 'CREATE_MANUAL_DUMMY', 'USERS', newUserId, req.ip || '', { display_name });
    res.json({ success: true, message: `User "${display_name}" berhasil dibuat!` });
  } catch (err: any) {
    res.status(500).json({ error: 'Gagal membuat user: ' + err.message });
  }
});

// 13. HAPUS PENGGUNA
router.delete('/users/:id', requireAdmin, async (req: any, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    await client.query('BEGIN');

    await client.query('DELETE FROM reports WHERE reported_user_id = $1 OR reporter_id = $1', [id]);
    await client.query('DELETE FROM messages WHERE sender_id = $1 OR receiver_id = $1', [id]);
    await client.query('DELETE FROM connections WHERE user_1_id = $1 OR user_2_id = $1', [id]);
    await client.query('DELETE FROM likes WHERE from_user_id = $1 OR to_user_id = $1', [id]);
    await client.query('DELETE FROM super_likes WHERE from_user_id = $1 OR to_user_id = $1', [id]);
    await client.query('DELETE FROM blocks WHERE blocker_id = $1 OR blocked_id = $1', [id]);
    await client.query('DELETE FROM user_photos WHERE user_id = $1', [id]);
    await client.query('DELETE FROM users WHERE id = $1', [id]);

    await client.query('COMMIT');
    await recordAudit(req.admin.id, 'DELETE_USER', 'USERS', id, req.ip || '', {});
    res.json({ success: true, message: 'Pengguna berhasil dihapus beserta seluruh datanya.' });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Gagal menghapus user: ' + err.message });
  } finally {
    client.release();
  }
});

// 14. BERSIHKAN SEMUA DUMMY
router.post('/clean-dummy-users', requireAdmin, async (req: any, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const dummyIdsRes = await client.query('SELECT id FROM users WHERE is_dummy = TRUE OR telegram_id >= 999000000');
    const dummyIds = dummyIdsRes.rows.map(r => r.id);

    if (dummyIds.length > 0) {
      await client.query('DELETE FROM reports WHERE reported_user_id = ANY($1::uuid[]) OR reporter_id = ANY($1::uuid[])', [dummyIds]);
      await client.query('DELETE FROM messages WHERE sender_id = ANY($1::uuid[]) OR receiver_id = ANY($1::uuid[])', [dummyIds]);
      await client.query('DELETE FROM connections WHERE user_1_id = ANY($1::uuid[]) OR user_2_id = ANY($1::uuid[])', [dummyIds]);
      await client.query('DELETE FROM likes WHERE from_user_id = ANY($1::uuid[]) OR to_user_id = ANY($1::uuid[])', [dummyIds]);
      await client.query('DELETE FROM super_likes WHERE from_user_id = ANY($1::uuid[]) OR to_user_id = ANY($1::uuid[])', [dummyIds]);
      await client.query('DELETE FROM blocks WHERE blocker_id = ANY($1::uuid[]) OR blocked_id = ANY($1::uuid[])', [dummyIds]);
      await client.query('DELETE FROM user_photos WHERE user_id = ANY($1::uuid[])', [dummyIds]);
      await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [dummyIds]);
    }

    await client.query('COMMIT');
    await recordAudit(req.admin.id, 'CLEAN_DUMMIES', 'USERS', 'ALL_DUMMIES', req.ip || '', {});
    res.json({ success: true, message: 'Semua dummy users telah dibersihkan.' });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Gagal membersihkan data: ' + err.message });
  } finally {
    client.release();
  }
});

// 15. RENDER HALAMAN ADMIN DASHBOARD
router.get('/', (req, res) => {
  const htmlPath = path.resolve(process.cwd(), 'src', 'views', 'admin.html');
  res.sendFile(htmlPath);
});

export default router;