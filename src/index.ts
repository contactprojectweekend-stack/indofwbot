import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { bot } from './bot';
import adminRouter, { seedAdmin } from './admin';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors());

// Redirect root '/' ke '/admin'
app.get('/', (req, res) => {
  res.redirect('/admin');
});

// Endpoint Webhook Telegram jika berjalan di Vercel / Cloud
app.post('/api/webhook', async (req, res) => {
  try {
    await bot.handleUpdate(req.body);
    res.status(200).send('OK');
  } catch (err) {
    console.error('Error Webhook handler:', err);
    res.status(500).send('Error');
  }
});

app.use('/admin', adminRouter);

const PORT = process.env.PORT || 3000;

async function start() {
  // 1. Validasi Environment Variables
  if (!process.env.BOT_TOKEN) {
    console.error('❌ FATAL ERROR: BOT_TOKEN tidak ditemukan di file .env');
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error('❌ FATAL ERROR: DATABASE_URL tidak ditemukan di file .env');
    return;
  }

  // 2. Jalankan Seeder Database
  await seedAdmin().catch((e) => console.error('Seeder warning:', e.message));

  // 3. Jalankan Bot
  const domainUrl = process.env.APP_URL;

  if (process.env.NODE_ENV === 'production' && domainUrl) {
    const webhookUrl = `${domainUrl}/api/webhook`;
    await bot.telegram.setWebhook(webhookUrl).catch((e) => console.error('Gagal set webhook:', e));
    console.log(`🚀 Telegram Bot berjalan dalam MODE WEBHOOK: ${webhookUrl}`);
  } else {
    // HAPUS WEBHOOK LAMA AGAR TIDAK TERJADI ERROR 409 CONFLICT
    await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
    
    bot.launch().then(() => {
      console.log('🤖 Telegram Bot BERHASIL AKTIF (Mode Polling)');
    }).catch((err) => {
      console.error('❌ Gagal menjalankan bot polling:', err.message);
    });
  }

  app.listen(PORT, () => {
    console.log(`🌐 Server Web aktif di port ${PORT}`);
    console.log(`🔑 Admin Dashboard: http://localhost:${PORT}/admin`);
  });
}

start();