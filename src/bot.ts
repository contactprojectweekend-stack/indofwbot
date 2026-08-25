import { Telegraf, Markup, session } from 'telegraf';
import { pool } from './db';

export const bot = new Telegraf<any>(process.env.BOT_TOKEN!);
bot.use(session());

bot.command('start', async (ctx) => {
  const tgId = ctx.from.id;
  const user = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [tgId]);

  if (user.rowCount === 0) {
    ctx.session = { step: 'ASK_AGE' };
    return ctx.reply('Selamat datang di Casual Match.\n\nBerapa usia kamu? (Kirim angka)');
  }

  if (!user.rows[0].profile_completed) {
    return ctx.reply('Profil kamu belum lengkap. Upload minimal 3 foto dan bagikan lokasi GPS.');
  }

  return showMainMenu(ctx);
});

bot.on('text', async (ctx, next) => {
  const step = ctx.session?.step;
  const text = ctx.message.text;

  if (ctx.session?.chatTargetUserId && !text.startsWith('/')) {
    const targetUserId = ctx.session.chatTargetUserId;
    const me = (await pool.query('SELECT id, is_suspended FROM users WHERE telegram_id = $1', [ctx.from.id])).rows[0];
    if (me.is_suspended) return ctx.reply('Akun kamu ditangguhkan.');

    const conn = await pool.query(
      `SELECT c.id, u.telegram_id as receiver_tg 
       FROM connections c
       JOIN users u ON (u.id = CASE WHEN c.user_1_id = $1 THEN c.user_2_id ELSE c.user_1_id END)
       WHERE ((c.user_1_id = $1 AND c.user_2_id = $2) OR (c.user_1_id = $2 AND c.user_2_id = $1)) 
         AND c.status = 'ACTIVE'`,
      [me.id, targetUserId]
    );

    if (conn.rowCount === 0) return ctx.reply('Percakapan tidak aktif.');

    const msgCount = await pool.query('SELECT COUNT(*)::int FROM messages WHERE connection_id = $1', [conn.rows[0].id]);
    if (msgCount.rows[0].count === 0) {
      await bot.telegram.sendMessage(
        conn.rows[0].receiver_tg,
        '🛡️ *Peringatan*: Jaga keamanan pribadi. Jangan memberikan data sensitif atau uang kepada orang baru.',
        { parse_mode: 'Markdown' }
      );
    }

    await pool.query(
      'INSERT INTO messages (connection_id, sender_id, receiver_id, message_text) VALUES ($1, $2, $3, $4)',
      [conn.rows[0].id, me.id, targetUserId, text]
    );

    await bot.telegram.sendMessage(conn.rows[0].receiver_tg, `💬 *Pesan Masuk:*\n${text}`, { parse_mode: 'Markdown' });
    return ctx.reply('✅ Pesan terkirim.');
  }

  if (step === 'ASK_AGE') {
    const age = parseInt(text, 10);
    if (isNaN(age)) return ctx.reply('Usia harus berupa angka. Masukkan usia kamu:');
    if (age < 18) {
      ctx.session = null;
      return ctx.reply('Bot ini hanya tersedia untuk pengguna berusia 18 tahun ke atas.');
    }

    ctx.session.age = age;
    ctx.session.step = 'ASK_GENDER';

    return ctx.reply(
      'Gender kamu?',
      Markup.inlineKeyboard([
        [Markup.button.callback('Pria', 'gender_pria'), Markup.button.callback('Wanita', 'gender_wanita')],
        [Markup.button.callback('Non-biner', 'gender_non-biner'), Markup.button.callback('Lainnya', 'gender_lainnya')],
        [Markup.button.callback('Tidak ingin menyebutkan', 'gender_tidak_disebutkan')]
      ])
    );
  }

  return next();
});

bot.action(/^gender_(.+)$/, async (ctx) => {
  ctx.session.gender = ctx.match[1];
  ctx.session.step = 'ASK_PREF';
  ctx.session.preferences = [];

  await ctx.editMessageText(
    'Kamu ingin mencari siapa?',
    Markup.inlineKeyboard([
      [Markup.button.callback('Pria', 'pref_pria'), Markup.button.callback('Wanita', 'pref_wanita')],
      [Markup.button.callback('Non-biner', 'pref_non-biner'), Markup.button.callback('Semua', 'pref_Semua')],
      [Markup.button.callback('➡️ Lanjut', 'pref_done')]
    ])
  );
});

bot.action(/^pref_(.+)$/, async (ctx) => {
  const val = ctx.match[1];
  if (val === 'done') {
    if (!ctx.session.preferences || ctx.session.preferences.length === 0) {
      return ctx.answerCbQuery('Pilih minimal satu preferensi gender!');
    }
    ctx.session.goals = [];
    return ctx.editMessageText(
      'Apa yang kamu cari? (Pilih satu atau lebih)',
      Markup.inlineKeyboard([
        [Markup.button.callback('FWB', 'goal_FWB'), Markup.button.callback('ONS', 'goal_ONS'), Markup.button.callback('Virtual', 'goal_Virtual')],
        [Markup.button.callback('💾 Simpan', 'goals_done')]
      ])
    );
  }
  if (!ctx.session.preferences) ctx.session.preferences = [];
  if (!ctx.session.preferences.includes(val)) ctx.session.preferences.push(val);
  await ctx.answerCbQuery(`Dipilih: ${val}`);
});

bot.action(/^goal_(.+)$/, async (ctx) => {
  const val = ctx.match[1];
  if (val === 'done') {
    if (!ctx.session.goals || ctx.session.goals.length === 0) return ctx.answerCbQuery('Pilih minimal satu tujuan!');

    await pool.query(
      `INSERT INTO users (telegram_id, username, display_name, age, gender, gender_preferences, relationship_goals)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (telegram_id) DO UPDATE SET age = $4, gender = $5, gender_preferences = $6, relationship_goals = $7`,
      [ctx.from!.id, ctx.from!.username || '', ctx.from!.first_name, ctx.session.age, ctx.session.gender, ctx.session.preferences, ctx.session.goals]
    );

    ctx.session.step = 'ASK_PHOTOS';
    return ctx.editMessageText('Upload minimal 3 foto profil (maksimal 5) untuk melanjutkan.');
  }
  if (!ctx.session.goals) ctx.session.goals = [];
  if (!ctx.session.goals.includes(val)) ctx.session.goals.push(val);
  await ctx.answerCbQuery(`Dipilih: ${val}`);
});

bot.on('photo', async (ctx) => {
  const user = (await pool.query('SELECT id FROM users WHERE telegram_id = $1', [ctx.from.id])).rows[0];
  if (!user) return;

  const countRes = await pool.query('SELECT COUNT(*)::int FROM user_photos WHERE user_id = $1', [user.id]);
  const currentCount = countRes.rows[0].count;

  if (currentCount >= 5) return ctx.reply('Maksimal 5 foto telah tercapai.');

  const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  const link = await ctx.telegram.getFileLink(fileId);

  await pool.query(
    'INSERT INTO user_photos (user_id, storage_path, file_url, is_primary) VALUES ($1, $2, $3, $4)',
    [user.id, fileId, link.href, currentCount === 0]
  );

  const newCount = currentCount + 1;
  if (newCount < 3) {
    return ctx.reply(`Foto tersimpan (${newCount}/3). Kirim ${3 - newCount} foto lagi.`);
  }

  return ctx.reply(
    `Foto lengkap (${newCount} foto). Kirim lokasi kamu agar kami dapat menemukan orang di sekitarmu.`,
    Markup.keyboard([[Markup.button.locationRequest('📍 Bagikan Lokasi GPS')]]).resize()
  );
});

bot.on('location', async (ctx) => {
  const { latitude, longitude } = ctx.message.location;
  await pool.query(
    'UPDATE users SET latitude = $1, longitude = $2, location_updated_at = NOW(), profile_completed = TRUE WHERE telegram_id = $3',
    [latitude, longitude, ctx.from.id]
  );
  await ctx.reply('Profil aktif dan matchmaking siap digunakan!', Markup.removeKeyboard());
  return showMainMenu(ctx);
});

bot.hears('🔎 Cari FWB', async (ctx) => {
  await findNextMatch(ctx);
});

async function findNextMatch(ctx: any) {
  const me = (await pool.query('SELECT * FROM users WHERE telegram_id = $1', [ctx.from.id])).rows[0];
  if (!me || !me.profile_completed) return ctx.reply('Lengkapi profil terlebih dahulu.');

  const query = `
    SELECT u.id, u.display_name, u.age, u.gender, u.relationship_goals,
      (6371 * acos(LEAST(1.0, GREATEST(-1.0, cos(radians($2)) * cos(radians(u.latitude)) * cos(radians(u.longitude) - radians($3)) + sin(radians($2)) * sin(radians(u.latitude)))))) AS distance_km,
      (SELECT COUNT(*) FROM user_photos up WHERE up.user_id = u.id) AS photo_count,
      (SELECT file_url FROM user_photos up WHERE up.user_id = u.id AND up.is_primary = true LIMIT 1) AS photo_url
    FROM users u
    WHERE u.id != $1 AND u.is_active = TRUE AND u.is_suspended = FALSE AND u.profile_completed = TRUE
      AND (u.gender = ANY($4) OR 'Semua' = ANY($4::text[]))
      AND u.relationship_goals && $5
      AND NOT EXISTS (SELECT 1 FROM likes l WHERE l.from_user_id = $1 AND l.to_user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM super_likes sl WHERE sl.from_user_id = $1 AND sl.to_user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = $1))
    ORDER BY distance_km ASC LIMIT 1
  `;

  const candidateRes = await pool.query(query, [me.id, me.latitude, me.longitude, me.gender_preferences, me.relationship_goals]);

  if (candidateRes.rowCount === 0) {
    return ctx.reply('Tidak ada profil baru di sekitar kamu saat ini.');
  }

  const c = candidateRes.rows[0];
  const dist = c.distance_km ? `${c.distance_km.toFixed(1)} km dari kamu` : 'Dekat';
  const caption = `*${c.display_name}, ${c.age}*\n\n⚧ ${c.gender}\n🎯 ${c.relationship_goals.join(' · ')}\n📍 ${dist}\n📷 ${c.photo_count} Foto`;

  const buttons = [
    [Markup.button.callback('❤️ Like', `act_like_${c.id}`), Markup.button.callback('⭐ Super Like', `act_sl_${c.id}`), Markup.button.callback('❌ Skip', `act_skip_${c.id}`)],
    [Markup.button.callback('🚫 Block', `act_block_${c.id}`), Markup.button.callback('⚠️ Report', `act_rep_${c.id}`)]
  ];

  if (c.photo_url) {
    await ctx.replyWithPhoto(c.photo_url, { caption, parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  } else {
    await ctx.reply(caption, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  }
}

bot.action(/^act_like_(.+)$/, async (ctx) => {
  const targetId = ctx.match[1];
  const me = (await pool.query('SELECT id FROM users WHERE telegram_id = $1', [ctx.from!.id])).rows[0];

  await pool.query('INSERT INTO likes (from_user_id, to_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [me.id, targetId]);
  await ctx.answerCbQuery('❤️ Disukai!');

  const mutual = await pool.query('SELECT 1 FROM likes WHERE from_user_id = $1 AND to_user_id = $2', [targetId, me.id]);
  if (mutual.rowCount! > 0) {
    await pool.query(
      `INSERT INTO connections (user_1_id, user_2_id, connection_type, status) VALUES ($1, $2, 'MUTUAL_LIKE', 'ACTIVE') ON CONFLICT DO NOTHING`,
      [me.id, targetId]
    );
    const target = (await pool.query('SELECT telegram_id FROM users WHERE id = $1', [targetId])).rows[0];
    await ctx.reply('🎉 It\'s a Match! Gunakan /matches untuk mulai chat.');
    await bot.telegram.sendMessage(target.telegram_id, '🎉 It\'s a Match! Seseorang menyukaimu kembali.');
  }

  await ctx.deleteMessage();
  return findNextMatch(ctx);
});

bot.action(/^act_sl_(.+)$/, async (ctx) => {
  const targetId = ctx.match[1];
  const me = (await pool.query('SELECT id FROM users WHERE telegram_id = $1', [ctx.from!.id])).rows[0];

  const count = (await pool.query('SELECT COUNT(*)::int FROM super_likes WHERE from_user_id = $1 AND created_at >= NOW() - INTERVAL \'24 hours\'', [me.id])).rows[0].count;
  if (count >= 3) {
    return ctx.answerCbQuery('Super Like hari ini sudah habis (Maks 3 per 24 jam).', { show_alert: true });
  }

  await pool.query('INSERT INTO super_likes (from_user_id, to_user_id) VALUES ($1, $2)', [me.id, targetId]);
  await pool.query(
    `INSERT INTO connections (user_1_id, user_2_id, connection_type, status) VALUES ($1, $2, 'SUPER_LIKE', 'ACTIVE') ON CONFLICT DO NOTHING`,
    [me.id, targetId]
  );

  const remaining = 3 - (count + 1);
  await ctx.answerCbQuery(`⭐ Super Like terkirim! (Sisa: ${remaining}/3)`);

  const target = (await pool.query('SELECT telegram_id FROM users WHERE id = $1', [targetId])).rows[0];
  await bot.telegram.sendMessage(target.telegram_id, '⭐ Seseorang mengirim Super Like dan langsung membuka chat denganmu!');

  await ctx.deleteMessage();
  return findNextMatch(ctx);
});

bot.action(/^act_skip_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Dilewati');
  await ctx.deleteMessage();
  return findNextMatch(ctx);
});

bot.command('matches', async (ctx) => {
  const me = (await pool.query('SELECT id FROM users WHERE telegram_id = $1', [ctx.from.id])).rows[0];
  const conns = await pool.query(
    `SELECT c.id, u.id as target_user_id, u.display_name, c.connection_type
     FROM connections c
     JOIN users u ON (u.id = CASE WHEN c.user_1_id = $1 THEN c.user_2_id ELSE c.user_1_id END)
     WHERE (c.user_1_id = $1 OR c.user_2_id = $1) AND c.status = 'ACTIVE'`,
    [me.id]
  );

  if (conns.rowCount === 0) return ctx.reply('Belum ada match aktif.');

  const btns = conns.rows.map((r: any) => [
    Markup.button.callback(`💬 Chat dengan ${r.display_name} (${r.connection_type})`, `startchat_${r.target_user_id}`)
  ]);

  return ctx.reply('Pilih obrolan:', Markup.inlineKeyboard(btns));
});

bot.action(/^startchat_(.+)$/, async (ctx) => {
  ctx.session.chatTargetUserId = ctx.match[1];
  const target = (await pool.query('SELECT display_name FROM users WHERE id = $1', [ctx.match[1]])).rows[0];
  await ctx.reply(`Chat terhubung dengan *${target.display_name}*. Ketik pesan langsung di bawah.`, { parse_mode: 'Markdown' });
});

function showMainMenu(ctx: any) {
  return ctx.reply(
    'Pilih menu utama:',
    Markup.keyboard([['🔎 Cari FWB', '❤️ Matches'], ['📍 Update Lokasi']]).resize()
  );
}