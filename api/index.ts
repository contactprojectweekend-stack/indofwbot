import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { bot } from '../src/bot';
import adminRouter, { seedAdmin } from '../src/admin';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors());

// Redirect root '/' langsung ke Admin Dashboard
app.get('/', (req, res) => {
  res.redirect('/admin');
});

// Endpoint Khusus Webhook Telegram Bot
app.post('/api/webhook', async (req, res) => {
  try {
    await bot.handleUpdate(req.body);
    res.status(200).send('OK');
  } catch (err) {
    console.error('Error Webhook:', err);
    res.status(500).send('Error');
  }
});

// Route Admin Dashboard
app.use('/admin', adminRouter);

// Jalankan seeder admin awal
seedAdmin().catch(console.error);

export default app;