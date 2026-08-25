import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { pool } from './db';
import path from 'path';

const router = Router();
const JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'secret';

export async function seedAdmin() {
  const email = 'contact.projectweekend@gmail.com';
  const defaultPass = 'Indonesia';
  const check = await pool.query('SELECT id FROM admins WHERE email = $1', [email]);
  if (check.rowCount === 0) {
    const hash = await bcrypt.hash(defaultPass, 12);
    await pool.query(
      `INSERT INTO admins (email, password_hash, role) VALUES ($1, $2, 'SUPER_ADMIN')`,
      [email, hash]
    );
    console.log('✅ Akun Admin bawaan disiapkan: contact.projectweekend@gmail.com');
  }
}

async function recordAudit(adminId: string, action: string, targetType: string, targetId: string, ip: string, meta: any) {
  await pool.query(
    `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, ip_address, metadata) VALUES ($1, $2, $3, $4, $5, $6)`,
    [adminId, action, targetType, targetId, ip, JSON.stringify(meta)]
  );
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

router.post('/change-password', requireAdmin, async (req: any, res) => {
  const { oldPassword, newPassword } = req.body;
  const adminRes = await pool.query('SELECT password_hash FROM admins WHERE id = $1', [req.admin.id]);
  const valid = await bcrypt.compare(oldPassword, adminRes.rows[0].password_hash);
  if (!valid) return res.status(400).json({ error: 'Password lama salah' });

  const newHash = await bcrypt.hash(newPassword, 12);
  await pool.query('UPDATE admins SET password_hash = $1 WHERE id = $2', [newHash, req.admin.id]);
  await recordAudit(req.admin.id, 'CHANGE_PASSWORD', 'ADMIN', req.admin.id, req.ip || '', {});
  res.json({ success: true, message: 'Password berhasil diubah' });
});

router.get('/users', requireAdmin, async (req: any, res) => {
  const data = await pool.query(`
    SELECT u.*, 
      (SELECT COUNT(*) FROM user_photos up WHERE up.user_id = u.id) AS photo_count,
      (SELECT COUNT(*) FROM likes l WHERE l.to_user_id = u.id) AS likes_count,
      (SELECT COUNT(*) FROM super_likes sl WHERE sl.to_user_id = u.id) AS superlikes_count
    FROM users u ORDER BY u.created_at DESC LIMIT 50
  `);
  await recordAudit(req.admin.id, 'VIEW_USERS', 'USER_LIST', 'ALL', req.ip || '', {});
  res.json(data.rows);
});

router.get('/conversations', requireAdmin, async (req: any, res) => {
  const data = await pool.query(`
    SELECT m.*, u1.display_name AS sender_name, u2.display_name AS receiver_name
    FROM messages m
    JOIN users u1 ON m.sender_id = u1.id
    JOIN users u2 ON m.receiver_id = u2.id
    ORDER BY m.created_at DESC LIMIT 50
  `);
  await recordAudit(req.admin.id, 'VIEW_CONVERSATIONS', 'MESSAGES', 'ALL', req.ip || '', {});
  res.json(data.rows);
});

router.get('/audit-logs', requireAdmin, async (req: any, res) => {
  const data = await pool.query(`
    SELECT l.*, a.email FROM admin_audit_logs l LEFT JOIN admins a ON l.admin_id = a.id ORDER BY l.created_at DESC LIMIT 100
  `);
  res.json(data.rows);
});

router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

export default router;