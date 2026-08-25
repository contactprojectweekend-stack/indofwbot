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

app.use('/admin', adminRouter);

const PORT = process.env.PORT || 3000;

async function start() {
  await seedAdmin();

  const domainUrl = process.env.APP_URL;

  if (process.env.NODE_ENV === 'production' && domainUrl) {
    const webhookUrl = `${domainUrl}/bot-webhook`;
    app.use(bot.webhookCallback('/bot-webhook'));
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`🚀 Webhook aktif di: ${webhookUrl}`);
  } else {
    bot.launch();
    console.log('🤖 Telegram Bot aktif dalam mode polling');
  }

  app.listen(PORT, () => {
    console.log(`🌐 Server berjalan di port ${PORT}`);
  });
}

start();