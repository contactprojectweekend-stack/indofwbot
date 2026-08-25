import { Telegraf, Markup, session } from 'telegraf';
import { pool } from './db';

export const bot = new Telegraf<any>(process.env.BOT_TOKEN!);

bot.catch((err: any, ctx: any) => {
  console.error(`⚠️ Error pada update ${ctx?.update?.update_id}:`, err?.message || err);
});

bot.use(session());
bot.use((ctx, next) => {
  if (!ctx.session) ctx.session = {};
  return next();
});

// =========================================================================
// ROUTER PESAN CHAT 2 ARAH (DENGAN TOMBOL KELUAR ROOM CHAT)
// =========================================================================
async function routeLiveChatMessage(ctx: any, msgType: 'text' | 'photo' | 'video', textContent: string = '', mediaUrl: string = '') {
  const targetUserId = ctx.session?.chatTargetUserId;
  if (!targetUserId) return false;

  try {
    const meRes = await pool.query('SELECT id, display_name, is_suspended FROM users WHERE telegram_id = $1', [ctx.from.id]);
    if (meRes.rowCount === 0 || meRes.rows[0].is_suspended) {
      ctx.reply('Akun kamu tidak dapat mengirim pesan.');
      return true;
    }
    const me = meRes.rows[0];

    const targetRes = await pool.query('SELECT id, telegram_id, display_name, username, is_vip, is_dummy, is_suspended FROM users WHERE id = $1', [targetUserId]);
    if (targetRes.rowCount === 0 || targetRes.rows[0].is_suspended) {
      ctx.session.chatTargetUserId = null;
      ctx.reply('Pasangan chat tidak ditemukan atau akun sedang dinonaktifkan.');
      return true;
    }
    const target = targetRes.rows[0];

    const connCheck = await pool.query(
      `SELECT id FROM connections 
       WHERE ((user_1_id = $1 AND user_2_id = $2) OR (user_1_id = $2 AND user_2_id = $1)) 
         AND status = 'ACTIVE'`,
      [me.id, target.id]
    );

    if (connCheck.rowCount === 0) {
      ctx.session.chatTargetUserId = null;
      ctx.reply('Koneksi obrolan ini sudah tidak aktif.');
      return true;
    }
    const connectionId = connCheck.rows[0].id;

    await pool.query(
      'INSERT INTO messages (connection_id, sender_id, receiver_id, message_type, message_text, media_url) VALUES ($1, $2, $3, $4, $5, $6)',
      [connectionId, me.id, target.id, msgType, textContent, mediaUrl]
    );

    const targetTgId = Number(target.telegram_id);
    const replyBtn = Markup.inlineKeyboard([
      [Markup.button.callback(`💬 Masuk Room & Balas ${me.display_name}`, `startchat_${me.id}`)]
    ]);

    if (!target.is_dummy) {
      if (msgType === 'photo') {
        await bot.telegram.sendPhoto(targetTgId, mediaUrl, {
          caption: textContent ? `💬 Foto dari ${me.display_name}:\n${textContent}` : `💬 Foto dari ${me.display_name}`,
          ...replyBtn
        }).catch((e) => console.error('Gagal kirim foto:', e));
      } else if (msgType === 'video') {
        await bot.telegram.sendVideo(targetTgId, mediaUrl, {
          caption: textContent ? `💬 Video dari ${me.display_name}:\n${textContent}` : `💬 Video dari ${me.display_name}`,
          ...replyBtn
        }).catch((e) => console.error('Gagal kirim video:', e));
      } else {
        await bot.telegram.sendMessage(
          targetTgId,
          `💬 Pesan dari ${me.display_name}:\n\n${textContent}`,
          replyBtn
        ).catch((e) => console.error('Gagal kirim teks:', e));
      }
    }

    const exitChatBtn = Markup.inlineKeyboard([
      [Markup.button.callback('🚪 Keluar dari Room Chat', 'exit_chat')]
    ]);

    await ctx.reply(`✅ Pesan terkirim ke *${target.display_name}*.`, { parse_mode: 'Markdown', ...exitChatBtn });

    if (target.is_vip && target.is_dummy) {
      setTimeout(async () => {
        const vipUser = target.username ? `@${target.username}` : 'VIP';
        const replyText = `⭐ *[VIP ${target.display_name}]*:\nHai ${me.display_name}! Senang mengobrol denganmu 😊\nSebagai member VIP, kamu juga bisa langsung chat Telegram pribadiku di: *${vipUser}*`;
        const btn = target.username ? [[Markup.button.url(`💬 Buka Telegram @${target.username}`, `https://t.me/${target.username}`)]] : [];
        await ctx.reply(replyText, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btn) }).catch(() => {});
      }, 1000);
    }

    return true;
  } catch (err) {
    console.error('Error routeLiveChatMessage:', err);
    ctx.reply('⚠️ Terjadi kendala saat mengirim pesan. Coba kirim ulang.');
    return false;
  }
}

// =========================================================================
// 1. COMMAND /START & REGISTRASI
// =========================================================================
bot.command('start', async (ctx) => {
  try {
    const tgId = ctx.from.id;
    const currentUsername = ctx.from.username || '';

    const userRes = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [tgId]);

    if (userRes.rowCount === 0) {
      ctx.session.step = 'ASK_NAME';
      return ctx.reply('Selamat datang di Casual Match!\n\nSiapa nama panggilan / display name kamu?');
    }

    const user = userRes.rows[0];
    if (user.is_suspended) return ctx.reply('⚠️ Akun kamu telah ditangguhkan.');

    if (!user.profile_completed) {
      const countRes = await pool.query('SELECT COUNT(*)::int FROM user_photos WHERE user_id = $1', [user.id]);
      const photoCount = countRes.rows[0].count;

      if (photoCount === 0) {
        ctx.session.step = 'ASK_PHOTO_SELFIE';
        return ctx.reply('Profil kamu belum lengkap.\n\n📸 *Upload Foto 1/3 (Selfie Kamera Depan)*:\nSilakan ambil dan kirimkan foto wajah selfie kamu sekarang:');
      } else if (photoCount < 3) {
        return ctx.reply(`Profil kamu baru memiliki ${photoCount}/3 foto. Silakan kirim ${3 - photoCount} foto profil lagi.`);
      } else {
        await pool.query('UPDATE users SET profile_completed = TRUE WHERE id = $1', [user.id]);
      }
    }

    return showMainMenu(ctx);
  } catch (error) {
    console.error('Error pada /start:', error);
    return ctx.reply('Terjadi kesalahan. Silakan coba lagi.');
  }
});

// =========================================================================
// 2. TEXT HANDLER
// =========================================================================
bot.on('text', async (ctx, next) => {
  const step = ctx.session?.step;
  const text = ctx.message.text;

  if (ctx.session?.chatTargetUserId && !text.startsWith('/')) {
    const handled = await routeLiveChatMessage(ctx, 'text', text);
    if (handled) return;
  }

  // Registrasi: Input Nama
  if (step === 'ASK_NAME') {
    const name = text.trim();
    if (name.length < 2 || name.length > 40) {
      return ctx.reply('Nama panggilan minimal 2 dan maksimal 40 karakter. Silakan masukkan nama kamu:');
    }

    ctx.session.regName = name;
    ctx.session.step = 'ASK_AGE';

    return ctx.reply(`Halo *${name}*! 👋\n\nBerapa usia kamu sekarang? (Kirim angka, minimal 18):`, { parse_mode: 'Markdown' });
  }

  // Registrasi: Input Usia
  if (step === 'ASK_AGE') {
    const age = parseInt(text, 10);
    if (isNaN(age)) return ctx.reply('Usia harus berupa angka. Masukkan usia kamu:');
    if (age < 18) {
      return ctx.reply('Bot ini hanya tersedia untuk pengguna berusia 18 tahun ke atas.');
    }

    const regName = ctx.session?.regName || ctx.from.first_name || 'User';

    await pool.query(
      `INSERT INTO users (telegram_id, username, display_name, age, gender, gender_preferences, relationship_goals, profile_completed)
       VALUES ($1, $2, $3, $4, 'tidak_disebutkan'::gender_type, ARRAY['pria','wanita']::gender_type[], ARRAY['FWB']::goal_type[], FALSE)
       ON CONFLICT (telegram_id) DO UPDATE SET display_name = $3, age = $4`,
      [ctx.from.id, ctx.from.username || '', regName, age]
    );

    ctx.session.step = 'ASK_GENDER';

    return ctx.reply(
      'Gender kamu?',
      Markup.inlineKeyboard([
        [Markup.button.callback('👨 Pria', 'gender_pria'), Markup.button.callback('👩 Wanita', 'gender_wanita')],
        [Markup.button.callback('⚧ Non-biner', 'gender_non-biner'), Markup.button.callback('🌈 Lainnya', 'gender_lainnya')],
        [Markup.button.callback('🤐 Tidak ingin menyebutkan', 'gender_tidak_disebutkan')]
      ])
    );
  }

  if (step === 'EDIT_NAME') {
    const newName = text.trim();
    if (newName.length < 2 || newName.length > 40) return ctx.reply('Nama tampilan minimal 2 dan maksimal 40 karakter.');
    await pool.query('UPDATE users SET display_name = $1 WHERE telegram_id = $2', [newName, ctx.from.id]);
    ctx.session.step = null;
    await ctx.reply(`✅ Nama tampilan berhasil diubah menjadi: *${newName}*`, { parse_mode: 'Markdown' });
    return showProfileCard(ctx);
  }

  if (step === 'EDIT_AGE') {
    const age = parseInt(text, 10);
    if (isNaN(age) || age < 18 || age > 99) return ctx.reply('Usia harus berupa angka dan minimal 18 tahun.');
    await pool.query('UPDATE users SET age = $1 WHERE telegram_id = $2', [age, ctx.from.id]);
    ctx.session.step = null;
    await ctx.reply(`✅ Usia berhasil diubah menjadi: *${age} tahun*`);
    return showProfileCard(ctx);
  }

  return next();
});

// =========================================================================
// 3. GENDER, PREFERENSI & GOALS REGISTRASI
// =========================================================================
bot.action(/^gender_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const gender = ctx.match[1];
  await pool.query('UPDATE users SET gender = $1::gender_type WHERE telegram_id = $2', [gender, ctx.from!.id]);
  
  ctx.session.regPreferences = ['pria', 'wanita'];

  return ctx.editMessageText(
    'Kamu ingin mencari siapa? (Bisa pilih lebih dari satu, lalu klik ➡️ Lanjut):',
    renderPrefKeyboard(ctx.session.regPreferences)
  ).catch(() => {});
});

bot.action(/^pref_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const val = ctx.match[1];
  if (!ctx.session.regPreferences) ctx.session.regPreferences = ['pria', 'wanita'];

  if (val === 'done') {
    const validGenders = ['pria', 'wanita', 'non-biner', 'lainnya', 'tidak_disebutkan'];
    let selected = ctx.session.regPreferences;
    if (selected.includes('Semua')) {
      selected = validGenders;
    } else {
      selected = selected.filter((p: string) => validGenders.includes(p));
    }
    if (selected.length === 0) selected = ['pria', 'wanita'];

    await pool.query('UPDATE users SET gender_preferences = $1::gender_type[] WHERE telegram_id = $2', [selected, ctx.from!.id]);
    
    ctx.session.regGoals = ['FWB'];
    return ctx.editMessageText(
      'Apa yang kamu cari? (Pilih satu atau lebih, lalu klik 💾 Simpan):',
      renderGoalKeyboard(ctx.session.regGoals)
    ).catch(() => {});
  }

  if (val === 'Semua') {
    if (ctx.session.regPreferences.includes('Semua')) {
      ctx.session.regPreferences = [];
    } else {
      ctx.session.regPreferences = ['pria', 'wanita', 'non-biner', 'Semua'];
    }
  } else {
    if (ctx.session.regPreferences.includes(val)) {
      ctx.session.regPreferences = ctx.session.regPreferences.filter((p: string) => p !== val && p !== 'Semua');
    } else {
      ctx.session.regPreferences.push(val);
    }
  }

  return ctx.editMessageReplyMarkup(renderPrefKeyboard(ctx.session.regPreferences).reply_markup).catch(() => {});
});

bot.action(/^goal_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const val = ctx.match[1];
  if (!ctx.session.regGoals) ctx.session.regGoals = ['FWB'];

  if (val === 'done') {
    const validGoals = ['FWB', 'ONS', 'Virtual'];
    let selected = ctx.session.regGoals;
    if (selected.includes('Semua')) {
      selected = validGoals;
    } else {
      selected = selected.filter((g: string) => validGoals.includes(g));
    }
    const finalGoals = selected.length > 0 ? selected : ['FWB'];

    await pool.query('UPDATE users SET relationship_goals = $1::goal_type[] WHERE telegram_id = $2', [finalGoals, ctx.from!.id]);
    
    ctx.session.step = 'ASK_PHOTO_SELFIE';
    return ctx.editMessageText(
      '✅ *Data profil tersimpan!*\n\n📸 *Aturan Upload 3 Foto Profil:*\n1. **Foto 1 (Wajib Selfie Kamera Depan)**: Ambil foto selfie langsung dari kamera depan Telegram.\n2. **Foto 2 & 3 (Foto Bebas)**: Foto aktivitas / foto bebas.\n\n👉 *Silakan kirimkan Foto 1 (Selfie Kamera Depan) sekarang:*',
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }

  if (val === 'Semua') {
    if (ctx.session.regGoals.includes('Semua')) {
      ctx.session.regGoals = [];
    } else {
      ctx.session.regGoals = ['FWB', 'ONS', 'Virtual', 'Semua'];
    }
  } else {
    if (ctx.session.regGoals.includes(val)) {
      ctx.session.regGoals = ctx.session.regGoals.filter((g: string) => g !== val && g !== 'Semua');
    } else {
      ctx.session.regGoals.push(val);
    }
  }

  return ctx.editMessageReplyMarkup(renderGoalKeyboard(ctx.session.regGoals).reply_markup).catch(() => {});
});

function renderPrefKeyboard(selected: string[] = [], isEdit: boolean = false) {
  const isSel = (key: string) => selected.includes(key) ? '✅ ' : '';
  const doneAction = isEdit ? 'edit_pref_save' : 'pref_done';
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(`${isSel('pria')}👨 Pria`, isEdit ? 'epref_pria' : 'pref_pria'),
      Markup.button.callback(`${isSel('wanita')}👩 Wanita`, isEdit ? 'epref_wanita' : 'pref_wanita')
    ],
    [
      Markup.button.callback(`${isSel('non-biner')}⚧ Non-biner`, isEdit ? 'epref_non-biner' : 'pref_non-biner'),
      Markup.button.callback(`${isSel('Semua')}🌈 Semua`, isEdit ? 'epref_Semua' : 'pref_Semua')
    ],
    [Markup.button.callback(isEdit ? '💾 Simpan Preferensi' : '➡️ Lanjut ke Tujuan Hubungan', doneAction)]
  ]);
}

function renderGoalKeyboard(selected: string[] = [], isEdit: boolean = false) {
  const isSel = (key: string) => selected.includes(key) ? '✅ ' : '';
  const doneAction = isEdit ? 'edit_goal_save' : 'goal_done';
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(`${isSel('FWB')}FWB`, isEdit ? 'egoal_FWB' : 'goal_FWB'),
      Markup.button.callback(`${isSel('ONS')}ONS`, isEdit ? 'egoal_ONS' : 'goal_ONS'),
      Markup.button.callback(`${isSel('Virtual')}Virtual`, isEdit ? 'egoal_Virtual' : 'goal_Virtual')
    ],
    [
      Markup.button.callback(`${isSel('Semua')}🌟 Semua Tujuan`, isEdit ? 'egoal_Semua' : 'goal_Semua')
    ],
    [Markup.button.callback(isEdit ? '💾 Simpan Tujuan' : '💾 Simpan & Lanjut Upload Foto', doneAction)]
  ]);
}

// =========================================================================
// 4. PHOTO HANDLER DENGAN SISTEM EDIT & GANTI
// =========================================================================
bot.on('photo', async (ctx) => {
  try {
    const msg = ctx.message;
    const photoArr = msg.photo;
    const fileId = photoArr[photoArr.length - 1].file_id;
    const link = await ctx.telegram.getFileLink(fileId);
    const caption = msg.caption || '';

    if (ctx.session?.chatTargetUserId) {
      const handled = await routeLiveChatMessage(ctx, 'photo', caption, fileId);
      if (handled) return;
    }

    const userRes = await pool.query('SELECT id, profile_completed FROM users WHERE telegram_id = $1', [ctx.from.id]);
    if (userRes.rowCount === 0) return;
    const user = userRes.rows[0];

    if (ctx.session?.step === 'REPLACE_SPECIFIC_PHOTO' && ctx.session?.replacePhotoId) {
      const photoId = ctx.session.replacePhotoId;
      await pool.query(
        'UPDATE user_photos SET storage_path = $1, file_url = $2 WHERE id = $3 AND user_id = $4',
        [fileId, link.href, photoId, user.id]
      );
      ctx.session.step = null;
      ctx.session.replacePhotoId = null;
      await ctx.reply('✅ *Foto profil berhasil diperbarui!*', { parse_mode: 'Markdown' });
      return showPhotoManagement(ctx);
    }

    if (ctx.session?.step === 'ADD_NEW_PHOTO') {
      const countRes = await pool.query('SELECT COUNT(*)::int FROM user_photos WHERE user_id = $1', [user.id]);
      if (countRes.rows[0].count >= 5) {
        ctx.session.step = null;
        return ctx.reply('⚠️ Kuota maksimal 5 foto profil telah tercapai.');
      }

      await pool.query(
        'INSERT INTO user_photos (user_id, storage_path, file_url, is_primary) VALUES ($1, $2, $3, false)',
        [user.id, fileId, link.href]
      );
      ctx.session.step = null;
      await ctx.reply('✅ *Foto profil baru berhasil ditambahkan!*', { parse_mode: 'Markdown' });
      return showPhotoManagement(ctx);
    }

    const countRes = await pool.query('SELECT COUNT(*)::int FROM user_photos WHERE user_id = $1', [user.id]);
    const currentCount = countRes.rows[0].count;

    if (currentCount >= 5) {
      return ctx.reply('Maksimal 5 foto profil telah tercapai. Buka menu ⚙️ Edit Profil untuk mengganti foto.');
    }

    const isPrimary = currentCount === 0;
    await pool.query(
      'INSERT INTO user_photos (user_id, storage_path, file_url, is_primary) VALUES ($1, $2, $3, $4)',
      [user.id, fileId, link.href, isPrimary]
    );

    const newCount = currentCount + 1;

    if (!user.profile_completed) {
      if (newCount === 1) {
        return ctx.reply('✅ *Foto 1 (Selfie Kamera Depan) tersimpan!*\n\n📸 Sekarang silakan kirimkan *Foto 2/3 (Foto Bebas/Aktivitas)*:', { parse_mode: 'Markdown' });
      } else if (newCount === 2) {
        return ctx.reply('✅ *Foto 2 berhasil disimpan!*\n\n📸 Sekarang kirimkan *Foto 3/3 (Foto Bebas)* untuk mengaktifkan profil kamu:', { parse_mode: 'Markdown' });
      } else if (newCount >= 3) {
        await pool.query('UPDATE users SET profile_completed = TRUE WHERE id = $1', [user.id]);
        await ctx.reply('🎉 *Syarat 3 foto profil telah lengkap!*\nProfil kamu kini aktif dan siap mencari pasangan!', { parse_mode: 'Markdown' });
        return showMainMenu(ctx);
      }
    } else {
      await ctx.reply(`✅ Foto profil tambahan berhasil disimpan (${newCount}/5 foto).`);
      return showPhotoManagement(ctx);
    }
  } catch (error) {
    console.error('Error upload foto:', error);
    return ctx.reply('Gagal memproses foto.');
  }
});

bot.on('video', async (ctx) => {
  try {
    if (ctx.session?.chatTargetUserId) {
      const fileId = ctx.message.video.file_id;
      const caption = ctx.message.caption || '';
      const handled = await routeLiveChatMessage(ctx, 'video', caption, fileId);
      if (handled) return;
    } else {
      return ctx.reply('Video hanya dapat dikirim saat sedang dalam obrolan aktif dengan pasangan match.');
    }
  } catch (error) {
    console.error('Error video:', error);
    return ctx.reply('Gagal memproses video.');
  }
});

// ==========================================
// 5. LIHAT PROFIL & EDIT PROFIL LENGKAP
// ==========================================
bot.hears('👤 Profil Saya', async (ctx) => {
  return showProfileCard(ctx);
});

bot.hears('⚙️ Edit Profil', async (ctx) => {
  return showEditMenu(ctx);
});

bot.command('profile', async (ctx) => {
  return showProfileCard(ctx);
});

bot.command('edit', async (ctx) => {
  return showEditMenu(ctx);
});

async function showProfileCard(ctx: any) {
  try {
    const userRes = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [ctx.from.id]);
    if (userRes.rowCount === 0) return ctx.reply('Profil belum terdaftar. Ketik /start');
    const u = userRes.rows[0];

    const photosRes = await pool.query('SELECT * FROM user_photos WHERE user_id = $1 ORDER BY is_primary DESC, created_at ASC', [u.id]);
    const photoCount = photosRes.rowCount || 0;
    const primaryPhoto = photosRes.rows.find((p: any) => p.is_primary) || photosRes.rows[0];

    const goalsStr = Array.isArray(u.relationship_goals) ? u.relationship_goals.join(' · ') : '-';
    const prefsStr = Array.isArray(u.gender_preferences) ? u.gender_preferences.join(', ') : '-';

    const cardText = 
      `👤 *KARTU PROFIL SAYA*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📛 *Nama*: ${u.display_name} ${u.is_vip ? '⭐ [VIP]' : ''}\n` +
      `🎂 *Usia*: ${u.age} tahun\n` +
      `⚧ *Gender*: ${u.gender}\n` +
      `🔎 *Mencari*: ${prefsStr}\n` +
      `🎯 *Tujuan Hubungan*: ${goalsStr}\n` +
      `📸 *Jumlah Foto*: ${photoCount}/5 Foto (Foto 1 = Selfie Utama)\n` +
      `⚡ *Status Akun*: ${u.profile_completed ? '✅ Aktif' : '⚠️ Belum Lengkap'}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `_Gunakan tombol di bawah untuk melihat galeri foto atau mengedit profil._`;

    const buttons = Markup.inlineKeyboard([
      [Markup.button.callback('🖼️ Galeri Foto Saya', 'btn_view_my_photos'), Markup.button.callback('⚙️ Edit Data Profil', 'btn_open_edit_menu')]
    ]);

    if (primaryPhoto) {
      const photoPayload = primaryPhoto.storage_path.startsWith('http') ? primaryPhoto.file_url : primaryPhoto.storage_path;
      try {
        return await ctx.replyWithPhoto(photoPayload, { caption: cardText, parse_mode: 'Markdown', ...buttons });
      } catch (e) {
        return await ctx.reply(cardText, { parse_mode: 'Markdown', ...buttons });
      }
    } else {
      return await ctx.reply(cardText, { parse_mode: 'Markdown', ...buttons });
    }
  } catch (err) {
    console.error('Error showProfileCard:', err);
    return ctx.reply('Gagal membuka profil.');
  }
}

bot.action('btn_view_my_photos', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    const userRes = await pool.query('SELECT id FROM users WHERE telegram_id = $1', [ctx.from!.id]);
    const photos = (await pool.query('SELECT * FROM user_photos WHERE user_id = $1 ORDER BY is_primary DESC, created_at ASC', [userRes.rows[0].id])).rows;

    if (photos.length === 0) return ctx.reply('Belum ada foto profil.');

    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      const caption = p.is_primary ? `📸 Foto ${i+1}: *Foto Selfie Kamera Depan (Utama)*` : `📸 Foto ${i+1}: Foto Bebas`;
      const photoPayload = p.storage_path.startsWith('http') ? p.file_url : p.storage_path;
      try {
        await ctx.replyWithPhoto(photoPayload, { caption, parse_mode: 'Markdown' });
      } catch {}
    }

    return ctx.reply(
      'Pilihan kelola foto:',
      Markup.inlineKeyboard([
        [Markup.button.callback('🖼️ Kelola / Ganti Foto', 'btn_edit_photos')],
        [Markup.button.callback('🔙 Kembali ke Profil', 'back_to_profile')]
      ])
    );
  } catch (e) {
    return ctx.reply('Gagal memuat galeri foto.');
  }
});

bot.action('btn_open_edit_menu', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return showEditMenu(ctx);
});

async function showEditMenu(ctx: any) {
  const text = `⚙️ *MENU EDIT PROFIL*\n\nPilih data profil yang ingin kamu perbarui:`;
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Ubah Nama', 'btn_edit_name'), Markup.button.callback('🎂 Ubah Usia', 'btn_edit_age')],
    [Markup.button.callback('⚧ Ubah Gender', 'btn_edit_gender'), Markup.button.callback('🔎 Ubah Preferensi', 'btn_edit_pref')],
    [Markup.button.callback('🎯 Ubah Tujuan Hubungan', 'btn_edit_goals')],
    [Markup.button.callback('🖼️ Kelola / Ganti / Tambah Foto', 'btn_edit_photos')],
    [Markup.button.callback('🔙 Kembali ke Profil Saya', 'back_to_profile')]
  ]);

  return ctx.reply(text, { parse_mode: 'Markdown', ...buttons });
}

bot.action('btn_edit_name', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.step = 'EDIT_NAME';
  return ctx.reply('Ketikkan *Nama Tampilan Baru* kamu:', { parse_mode: 'Markdown' });
});

bot.action('btn_edit_age', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.step = 'EDIT_AGE';
  return ctx.reply('Ketikkan *Usia Baru* kamu (minimal 18):', { parse_mode: 'Markdown' });
});

bot.action('btn_edit_gender', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return ctx.reply(
    'Pilih Gender kamu yang baru:',
    Markup.inlineKeyboard([
      [Markup.button.callback('👨 Pria', 'setg_pria'), Markup.button.callback('👩 Wanita', 'setg_wanita')],
      [Markup.button.callback('⚧ Non-biner', 'setg_non-biner'), Markup.button.callback('🌈 Lainnya', 'setg_lainnya')],
      [Markup.button.callback('🤐 Tidak ingin menyebutkan', 'setg_tidak_disebutkan')]
    ])
  );
});

bot.action(/^setg_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const newGender = ctx.match[1];
  await pool.query('UPDATE users SET gender = $1::gender_type WHERE telegram_id = $2', [newGender, ctx.from!.id]);
  await ctx.reply(`✅ Gender kamu berhasil diubah menjadi: *${newGender}*`, { parse_mode: 'Markdown' });
  return showProfileCard(ctx);
});

// Edit Preferensi Gender
bot.action('btn_edit_pref', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    const meRes = await pool.query('SELECT gender_preferences FROM users WHERE telegram_id = $1', [ctx.from!.id]);
    const currentPrefs = meRes.rows[0]?.gender_preferences || [];
    ctx.session.editPreferences = Array.isArray(currentPrefs) ? [...currentPrefs] : [];

    return ctx.reply(
      'Pilih preferensi gender yang ingin kamu cari (bisa pilih lebih dari satu, lalu klik 💾 Simpan):',
      renderPrefKeyboard(ctx.session.editPreferences, true)
    );
  } catch (err) {
    return ctx.reply('Gagal membuka pengaturan preferensi.');
  }
});

bot.action(/^epref_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const val = ctx.match[1];
  try {
    if (!ctx.session.editPreferences) {
      const meRes = await pool.query('SELECT gender_preferences FROM users WHERE telegram_id = $1', [ctx.from!.id]);
      ctx.session.editPreferences = meRes.rows[0]?.gender_preferences || [];
    }

    if (val === 'Semua') {
      if (ctx.session.editPreferences.includes('Semua')) {
        ctx.session.editPreferences = [];
      } else {
        ctx.session.editPreferences = ['pria', 'wanita', 'non-biner', 'Semua'];
      }
    } else {
      if (ctx.session.editPreferences.includes(val)) {
        ctx.session.editPreferences = ctx.session.editPreferences.filter((p: string) => p !== val && p !== 'Semua');
      } else {
        ctx.session.editPreferences.push(val);
      }
    }
    return ctx.editMessageReplyMarkup(renderPrefKeyboard(ctx.session.editPreferences, true).reply_markup).catch(() => {});
  } catch (err) {
    console.error('Error epref_:', err);
  }
});

bot.action('edit_pref_save', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    const validGenders = ['pria', 'wanita', 'non-biner', 'lainnya', 'tidak_disebutkan'];
    let selected = ctx.session.editPreferences || [];

    if (selected.includes('Semua')) {
      selected = validGenders;
    } else {
      selected = selected.filter((p: string) => validGenders.includes(p));
    }

    if (selected.length === 0) {
      return ctx.reply('⚠️ Pilih minimal satu preferensi gender sebelum menyimpan!');
    }

    await pool.query('UPDATE users SET gender_preferences = $1::gender_type[] WHERE telegram_id = $2', [selected, ctx.from!.id]);
    ctx.session.editPreferences = null;
    await ctx.reply('✅ Preferensi gender berhasil diperbarui.');
    return showProfileCard(ctx);
  } catch (err) {
    return ctx.reply('Terjadi kesalahan saat menyimpan preferensi.');
  }
});

// Edit Tujuan Hubungan
bot.action('btn_edit_goals', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    const meRes = await pool.query('SELECT relationship_goals FROM users WHERE telegram_id = $1', [ctx.from!.id]);
    const currentGoals = meRes.rows[0]?.relationship_goals || [];
    ctx.session.editGoals = Array.isArray(currentGoals) ? [...currentGoals] : [];

    return ctx.reply(
      'Pilih tujuan hubungan kamu (bisa pilih lebih dari satu, lalu klik 💾 Simpan):',
      renderGoalKeyboard(ctx.session.editGoals, true)
    );
  } catch (err) {
    return ctx.reply('Gagal membuka pengaturan tujuan hubungan.');
  }
});

bot.action(/^egoal_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const val = ctx.match[1];
  try {
    if (!ctx.session.editGoals) {
      const meRes = await pool.query('SELECT relationship_goals FROM users WHERE telegram_id = $1', [ctx.from!.id]);
      ctx.session.editGoals = meRes.rows[0]?.relationship_goals || [];
    }

    if (val === 'Semua') {
      if (ctx.session.editGoals.includes('Semua')) {
        ctx.session.editGoals = [];
      } else {
        ctx.session.editGoals = ['FWB', 'ONS', 'Virtual', 'Semua'];
      }
    } else {
      if (ctx.session.editGoals.includes(val)) {
        ctx.session.editGoals = ctx.session.editGoals.filter((g: string) => g !== val && g !== 'Semua');
      } else {
        ctx.session.editGoals.push(val);
      }
    }
    return ctx.editMessageReplyMarkup(renderGoalKeyboard(ctx.session.editGoals, true).reply_markup).catch(() => {});
  } catch (err) {
    console.error('Error egoal_:', err);
  }
});

bot.action('edit_goal_save', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    const validGoals = ['FWB', 'ONS', 'Virtual'];
    let selected = ctx.session.editGoals || [];

    if (selected.includes('Semua')) {
      selected = validGoals;
    } else {
      selected = selected.filter((g: string) => validGoals.includes(g));
    }

    if (selected.length === 0) {
      return ctx.reply('⚠️ Pilih minimal satu tujuan hubungan sebelum menyimpan!');
    }

    await pool.query('UPDATE users SET relationship_goals = $1::goal_type[] WHERE telegram_id = $2', [selected, ctx.from!.id]);
    ctx.session.editGoals = null;
    await ctx.reply('✅ Tujuan hubungan berhasil diperbarui.');
    return showProfileCard(ctx);
  } catch (err) {
    return ctx.reply('Terjadi kesalahan saat menyimpan tujuan hubungan.');
  }
});

// Kelola & Ganti Foto
bot.action('btn_edit_photos', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return showPhotoManagement(ctx);
});

async function showPhotoManagement(ctx: any) {
  try {
    const userRes = await pool.query('SELECT id FROM users WHERE telegram_id = $1', [ctx.from.id]);
    if (userRes.rowCount === 0) return;
    const userId = userRes.rows[0].id;

    const photos = (await pool.query('SELECT * FROM user_photos WHERE user_id = $1 ORDER BY is_primary DESC, created_at ASC', [userId])).rows;

    let text = `📸 *MANAJEMEN FOTO PROFIL (${photos.length}/5 Foto)*\n\n`;
    text += `• Foto 1: *Selfie Kamera Depan (Utama)*.\n`;
    text += `• Tekan tombol **🔄 Ganti** untuk menimpa foto pilihan Anda.\n`;
    text += `• Tekan tombol **➕ Tambah** untuk menambah foto baru (maks 5 foto).\n\n`;

    const buttons: any[] = [];

    photos.forEach((p, idx) => {
      const labelGanti = p.is_primary ? `🔄 Ganti Foto ${idx + 1} (Selfie Utama)` : `🔄 Ganti Foto ${idx + 1}`;
      const row = [Markup.button.callback(labelGanti, `btn_replace_p_${p.id}`)];
      
      if (photos.length > 3) {
        row.push(Markup.button.callback(`🗑️ Hapus`, `del_my_photo_${p.id}`));
      }
      buttons.push(row);
    });

    if (photos.length < 5) {
      buttons.push([Markup.button.callback('➕ Tambah Foto Baru (Slot Tersedia)', 'btn_add_new_photo')]);
    }

    buttons.push([Markup.button.callback('🔙 Kembali ke Profil', 'back_to_profile')]);

    return ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  } catch (err) {
    console.error('Error showPhotoManagement:', err);
  }
}

bot.action(/^btn_replace_p_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const photoId = ctx.match[1];
  ctx.session.step = 'REPLACE_SPECIFIC_PHOTO';
  ctx.session.replacePhotoId = photoId;

  return ctx.reply('📸 *Kirimkan Foto Pengganti:*\n\nSilakan kirimkan foto baru sekarang melalui chat ini untuk menggantikan foto tersebut.', { parse_mode: 'Markdown' });
});

bot.action('btn_add_new_photo', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.step = 'ADD_NEW_PHOTO';

  return ctx.reply('📸 *Tambah Foto Baru:*\n\nSilakan kirimkan foto baru sekarang melalui chat ini.', { parse_mode: 'Markdown' });
});

bot.action(/^del_my_photo_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    const photoId = ctx.match[1];
    const userRes = await pool.query('SELECT id FROM users WHERE telegram_id = $1', [ctx.from!.id]);
    const userId = userRes.rows[0].id;

    const countRes = await pool.query('SELECT COUNT(*)::int FROM user_photos WHERE user_id = $1', [userId]);
    const totalPhotos = countRes.rows[0].count;

    if (totalPhotos <= 3) {
      return ctx.reply('⚠️ Tidak dapat menghapus foto. Akun kamu wajib memiliki minimal 3 foto profil aktif!');
    }

    await pool.query('DELETE FROM user_photos WHERE id = $1 AND user_id = $2', [photoId, userId]);
    await pool.query(
      `UPDATE user_photos SET is_primary = TRUE WHERE id = (SELECT id FROM user_photos WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1)`,
      [userId]
    );

    await ctx.reply('🗑️ Foto profil berhasil dihapus.');
    return showPhotoManagement(ctx);
  } catch (err) {
    return ctx.reply('Gagal menghapus foto.');
  }
});

bot.action('back_to_profile', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return showProfileCard(ctx);
});

// ==========================================
// 6. DISCOVERY & MATCHING ENGINE
// ==========================================
bot.hears('🔎 Cari FWB', async (ctx) => {
  await findNextMatch(ctx);
});

bot.command('search', async (ctx) => {
  await findNextMatch(ctx);
});

async function findNextMatch(ctx: any) {
  try {
    const meRes = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [ctx.from.id]);
    if (meRes.rowCount === 0 || !meRes.rows[0].profile_completed) {
      return ctx.reply('Lengkapi pendaftaran dan upload minimal 3 foto profil (1 selfie kamera depan) terlebih dahulu.');
    }
    const me = meRes.rows[0];

    const skippedIds = ctx.session?.skippedUserIds || [];

    const query = `
      SELECT u.id, u.display_name, u.username, u.telegram_id, u.age, u.gender, u.relationship_goals, u.is_vip,
        (SELECT COUNT(*) FROM user_photos up WHERE up.user_id = u.id) AS photo_count,
        (SELECT storage_path FROM user_photos up WHERE up.user_id = u.id AND up.is_primary = true LIMIT 1) AS photo_storage_path,
        (SELECT file_url FROM user_photos up WHERE up.user_id = u.id AND up.is_primary = true LIMIT 1) AS photo_url
      FROM users u
      WHERE u.id != $1 
        AND u.is_active = TRUE 
        AND u.is_suspended = FALSE 
        AND u.profile_completed = TRUE
        AND u.gender::text = ANY($2::text[])
        AND u.relationship_goals::text[] && $3::text[]
        AND NOT EXISTS (SELECT 1 FROM likes l WHERE l.from_user_id = $1 AND l.to_user_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM super_likes sl WHERE sl.from_user_id = $1 AND sl.to_user_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = $1))
        AND NOT (u.id = ANY($4::uuid[]))
      ORDER BY u.last_active_at DESC LIMIT 1
    `;

    const candidateRes = await pool.query(query, [
      me.id,
      me.gender_preferences || [],
      me.relationship_goals || [],
      skippedIds
    ]);

    if (candidateRes.rowCount === 0) {
      return ctx.reply('Belum ada kandidat baru yang cocok, yuk invite temen kamu biar makin banyak yang main FWBot ini');
    }

    const c = candidateRes.rows[0];
    const goalsList = Array.isArray(c.relationship_goals) ? c.relationship_goals.join(' · ') : '';
    const isVip = c.is_vip === true;

    const titleName = isVip ? `⭐ VIP ${c.display_name}, ${c.age} ⭐` : `${c.display_name}, ${c.age}`;
    const vipTag = isVip ? `🌟 *Status*: VIP Verified Member\n` : '';

    const caption = 
      `*${titleName}*\n\n` +
      vipTag +
      `⚧ ${c.gender}\n` +
      `🎯 ${goalsList}\n` +
      `📷 ${c.photo_count || 0} Foto (Termasuk Selfie Kamera Depan)`;

    const buttons = [
      [
        Markup.button.callback('❤️ Like', `act_like_${c.id}`),
        Markup.button.callback('⭐ Super Like', `act_sl_${c.id}`),
        Markup.button.callback('❌ Skip', `act_skip_${c.id}`)
      ],
      [
        Markup.button.callback('🚫 Block', `act_block_${c.id}`),
        Markup.button.callback('⚠️ Report', `act_rep_${c.id}`)
      ]
    ];

    if (c.photo_storage_path || c.photo_url) {
      const photoPayload = (c.photo_storage_path && !c.photo_storage_path.startsWith('http')) ? c.photo_storage_path : c.photo_url;
      try {
        return await ctx.replyWithPhoto(photoPayload, { caption, parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
      } catch {
        return await ctx.reply(caption, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
      }
    } else {
      return await ctx.reply(caption, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    }
  } catch (error) {
    console.error('Error discovery SQL:', error);
    return ctx.reply('Terjadi kesalahan saat mencari kandidat.');
  }
}

// ==========================================
// 7. ACTIONS (LIKE, SUPER LIKE, SKIP, BLOCK, REPORT)
// ==========================================
bot.action(/^act_like_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('❤️ Disukai!').catch(() => {});
  try {
    const targetId = ctx.match[1];
    const me = (await pool.query('SELECT id, telegram_id, display_name FROM users WHERE telegram_id = $1', [ctx.from!.id])).rows[0];

    await pool.query('INSERT INTO likes (from_user_id, to_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [me.id, targetId]);

    const mutual = await pool.query('SELECT 1 FROM likes WHERE from_user_id = $1 AND to_user_id = $2', [targetId, me.id]);
    if (mutual.rowCount! > 0) {
      await pool.query(
        `INSERT INTO connections (user_1_id, user_2_id, connection_type, status) VALUES ($1, $2, 'MUTUAL_LIKE', 'ACTIVE') ON CONFLICT DO NOTHING`,
        [me.id, targetId]
      );
      const target = (await pool.query('SELECT telegram_id, display_name, username, is_vip, is_dummy FROM users WHERE id = $1', [targetId])).rows[0];
      const isTargetVip = target.is_vip === true;

      if (isTargetVip) {
        const vipBtns = target.username ? [
          [Markup.button.url(`💬 Chat Langsung di Telegram ⭐ @${target.username} ⭐`, `https://t.me/${target.username}`)],
          [Markup.button.callback('💬 Chat via Bot', `startchat_${targetId}`)]
        ] : [
          [Markup.button.callback('💬 Chat via Bot', `startchat_${targetId}`)]
        ];

        await ctx.reply(
          `🎉 *IT'S A MATCH WITH VIP!*\n\n` +
          `Kamu saling menyukai dengan *⭐ VIP ${target.display_name} ⭐*!\n\n` +
          `🌟 *VIP Telegram*: @${target.username || 'VIP_User'}\n\n` +
          `Silakan hubungi pasangan VIP kamu:`,
          { parse_mode: 'Markdown', ...Markup.inlineKeyboard(vipBtns) }
        );
      } else {
        const realBtns = [
          [Markup.button.callback(`💬 Chat dengan ${target.display_name}`, `startchat_${targetId}`)]
        ];

        await ctx.reply(
          `🎉 *IT'S A MATCH!*\n\n` +
          `Kamu dan *${target.display_name}* saling menyukai!\n` +
          `🔒 *Privasi Terjaga*: Identitas asli kamu aman. Silakan mulai mengobrol di room chat bot:`,
          { parse_mode: 'Markdown', ...Markup.inlineKeyboard(realBtns) }
        );

        if (!target.is_dummy) {
          await bot.telegram.sendMessage(
            Number(target.telegram_id),
            `🎉 *IT'S A MATCH!*\n\n*${me.display_name}* menyukai kamu kembali!\n🔒 Silakan buka menu ❤️ Matches untuk mulai mengobrol secara aman.`,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback(`💬 Chat dengan ${me.display_name}`, `startchat_${me.id}`)]]) }
          ).catch((e) => console.error('Gagal notif match ke target:', e));
        }
      }
    }

    await ctx.deleteMessage().catch(() => {});
    return findNextMatch(ctx);
  } catch (err) {
    return findNextMatch(ctx);
  }
});

bot.action(/^act_sl_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  try {
    const targetId = ctx.match[1];
    const me = (await pool.query('SELECT id, telegram_id, display_name FROM users WHERE telegram_id = $1', [ctx.from!.id])).rows[0];

    const countRes = await pool.query(
      "SELECT COUNT(*)::int FROM super_likes WHERE from_user_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'",
      [me.id]
    );
    const count = countRes.rows[0].count;

    if (count >= 3) {
      return ctx.reply('⚠️ Super Like hari ini sudah habis (Maksimal 3 per 24 jam).');
    }

    await pool.query('INSERT INTO super_likes (from_user_id, to_user_id) VALUES ($1, $2)', [me.id, targetId]);
    await pool.query(
      `INSERT INTO connections (user_1_id, user_2_id, connection_type, status) VALUES ($1, $2, 'SUPER_LIKE', 'ACTIVE') ON CONFLICT DO NOTHING`,
      [me.id, targetId]
    );

    const target = (await pool.query('SELECT telegram_id, display_name, username, is_vip, is_dummy FROM users WHERE id = $1', [targetId])).rows[0];
    const isTargetVip = target.is_vip === true;

    if (isTargetVip) {
      const vipBtns = target.username ? [
        [Markup.button.url(`💬 Chat Langsung di Telegram ⭐ @${target.username} ⭐`, `https://t.me/${target.username}`)],
        [Markup.button.callback('💬 Chat via Bot', `startchat_${targetId}`)]
      ] : [
        [Markup.button.callback('💬 Chat via Bot', `startchat_${targetId}`)]
      ];

      await ctx.reply(
        `⭐ *SUPER LIKE TERKIRIM KE VIP!*\n\n` +
        `Kamu langsung terhubung dengan *⭐ VIP ${target.display_name} ⭐*!\n\n` +
        `🌟 *VIP Telegram*: @${target.username || 'VIP_User'}`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard(vipBtns) }
      );
    } else {
      const realBtns = [
        [Markup.button.callback(`💬 Chat dengan ${target.display_name}`, `startchat_${targetId}`)]
      ];

      await ctx.reply(
        `⭐ *SUPER LIKE TERKIRIM!*\n\n` +
        `Kamu langsung terhubung dengan *${target.display_name}*!\n` +
        `🔒 Room chat aman telah dibuka di bot:`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard(realBtns) }
      );

      if (!target.is_dummy) {
        await bot.telegram.sendMessage(
          Number(target.telegram_id),
          `⭐ *SUPER LIKE MASUK!*\n\n*${me.display_name}* mengirimkan Super Like kepada kamu! Buka menu ❤️ Matches untuk membalas.`,
          { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback(`💬 Chat dengan ${me.display_name}`, `startchat_${me.id}`)]]) }
        ).catch((e) => console.error('Gagal notif superlike ke target:', e));
      }
    }

    await ctx.deleteMessage().catch(() => {});
    return findNextMatch(ctx);
  } catch (err) {
    return findNextMatch(ctx);
  }
});

bot.action(/^act_skip_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Dilewati').catch(() => {});
  const targetId = ctx.match[1];
  if (!ctx.session.skippedUserIds) ctx.session.skippedUserIds = [];
  ctx.session.skippedUserIds.push(targetId);

  await ctx.deleteMessage().catch(() => {});
  return findNextMatch(ctx);
});

bot.action(/^act_block_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Pengguna telah diblokir secara permanen.').catch(() => {});
  try {
    const targetId = ctx.match[1];
    const me = (await pool.query('SELECT id FROM users WHERE telegram_id = $1', [ctx.from!.id])).rows[0];

    await pool.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [me.id, targetId]);
    await pool.query(`UPDATE connections SET status = 'BLOCKED' WHERE ((user_1_id = $1 AND user_2_id = $2) OR (user_1_id = $2 AND user_2_id = $1))`, [me.id, targetId]);

    await ctx.deleteMessage().catch(() => {});
    return findNextMatch(ctx);
  } catch (err) {
    return findNextMatch(ctx);
  }
});

// Aksi Report (Privasi Aman Tanpa Menyebut @pramdka ke Pengguna)
bot.action(/^act_rep_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('⚠️ Laporan kamu telah dikirim ke Tim Moderasi untuk ditinjau.', { show_alert: true });
  try {
    const targetId = ctx.match[1];
    const me = (await pool.query('SELECT id, telegram_id, display_name, username FROM users WHERE telegram_id = $1', [ctx.from!.id])).rows[0];
    const target = (await pool.query('SELECT id, telegram_id, display_name, username FROM users WHERE id = $1', [targetId])).rows[0];

    // 1. Simpan ke database laporan (muncul di admin dashboard)
    await pool.query('INSERT INTO reports (reporter_id, reported_user_id, reason) VALUES ($1, $2, $3)', [me.id, targetId, 'Dilaporkan dari Discovery Card']);

    // 2. Kirim notifikasi senyap ke admin jika terdaftar
    const reportAlert = 
      `🚨 *LAPORAN PENGGUNA MASUK*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 *Pelapor*: ${me.display_name} (@${me.username || 'tanpa_username'}) [ID: \`${me.telegram_id}\`]\n` +
      `🚫 *Dilaporkan*: ${target.display_name} (@${target.username || 'tanpa_username'}) [ID: \`${target.telegram_id}\`]\n` +
      `📅 *Waktu*: ${new Date().toLocaleString('id-ID')}\n` +
      `📝 *Keterangan*: Dilaporkan melalui tombol Discovery Matchmaker.`;

    const adminRes = await pool.query(`SELECT telegram_id FROM users WHERE username ILIKE 'pramdka' LIMIT 1`);
    if (adminRes.rowCount! > 0) {
      await bot.telegram.sendMessage(Number(adminRes.rows[0].telegram_id), reportAlert, { parse_mode: 'Markdown' }).catch(() => {});
    }

    if (!ctx.session.skippedUserIds) ctx.session.skippedUserIds = [];
    ctx.session.skippedUserIds.push(targetId);

    await ctx.deleteMessage().catch(() => {});
    return findNextMatch(ctx);
  } catch (err) {
    return findNextMatch(ctx);
  }
});

// ==========================================
// 8. LIST MATCHES & ROOM CHAT LANGSUNG
// ==========================================
bot.hears('❤️ Matches', async (ctx) => {
  return showMatches(ctx);
});

bot.command('matches', async (ctx) => {
  return showMatches(ctx);
});

async function showMatches(ctx: any) {
  try {
    const meRes = await pool.query('SELECT id FROM users WHERE telegram_id = $1', [ctx.from.id]);
    if (meRes.rowCount === 0) return ctx.reply('Profil belum terdaftar.');
    const me = meRes.rows[0];

    const conns = await pool.query(
      `SELECT c.id, u.id as target_user_id, u.display_name, u.username, u.telegram_id, u.is_vip, c.connection_type
       FROM connections c
       JOIN users u ON (u.id = CASE WHEN c.user_1_id = $1 THEN c.user_2_id ELSE c.user_1_id END)
       WHERE (c.user_1_id = $1 OR c.user_2_id = $1) AND c.status = 'ACTIVE' AND u.is_suspended = FALSE`,
      [me.id]
    );

    if (conns.rowCount === 0) {
      return ctx.reply('Belum ada match atau koneksi aktif saat ini. Buka menu 🔎 Cari FWB untuk mencari pasangan baru.');
    }

    const btns = conns.rows.map((r: any) => {
      const isVip = r.is_vip === true;
      const title = isVip ? `💬 Chat: ⭐ VIP ${r.display_name} ⭐` : `💬 Chat: ${r.display_name} (${r.connection_type === 'SUPER_LIKE' ? 'Super Like' : 'Match'})`;
      return [
        Markup.button.callback(title, `startchat_${r.target_user_id}`)
      ];
    });

    return ctx.reply(
      `❤️ *DAFTAR PASANGAN MATCH KAMU (${conns.rowCount})*\n\nKlik nama pasangan di bawah ini untuk langsung membuka obrolan:`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) }
    );
  } catch (err) {
    console.error('Error list matches:', err);
    return ctx.reply('Gagal mengambil daftar match.');
  }
}

bot.action(/^startchat_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const targetId = ctx.match[1];
  ctx.session.chatTargetUserId = targetId;

  const targetRes = await pool.query('SELECT display_name, username, telegram_id, is_vip FROM users WHERE id = $1', [targetId]);
  if (targetRes.rowCount === 0) return ctx.reply('Pengguna tidak ditemukan.');
  const target = targetRes.rows[0];
  const isVip = target.is_vip === true;

  if (isVip) {
    const directLinkBtn = target.username ? [
      [Markup.button.url(`💬 Buka Telegram ⭐ @${target.username} ⭐`, `https://t.me/${target.username}`)],
      [Markup.button.callback('🚪 Keluar dari Room Chat', 'exit_chat')]
    ] : [[Markup.button.callback('🚪 Keluar dari Room Chat', 'exit_chat')]];

    await ctx.reply(
      `💬 *Chat Terhubung dengan ⭐ VIP ${target.display_name} ⭐*\n\n` +
      `🌟 *VIP Telegram*: @${target.username || 'VIP'}\n\n` +
      `Ketik pesan teks, foto, atau video langsung di chat ini untuk mengobrol, atau hubungi via Telegram.`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(directLinkBtn) }
    );
  } else {
    const exitBtn = Markup.inlineKeyboard([
      [Markup.button.callback('🚪 Keluar dari Room Chat', 'exit_chat')]
    ]);

    await ctx.reply(
      `💬 *Room Chat Aktif dengan ${target.display_name}*\n\n` +
      `🔒 *Privasi Aman*: Username Telegram kamu tidak dibagikan. Semua pesan teks, foto, dan video yang kamu kirimkan di sini akan otomatis diteruskan langsung ke *${target.display_name}*.\n\n_Ketik pesan balasan kamu di bawah ini:_`,
      { parse_mode: 'Markdown', ...exitBtn }
    );
  }
});

bot.action('exit_chat', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  ctx.session.chatTargetUserId = null;
  await ctx.reply('🚪 Kamu telah keluar dari room chat.');
  return showMainMenu(ctx);
});

function showMainMenu(ctx: any) {
  return ctx.reply(
    'Pilih menu utama:',
    Markup.keyboard([
      ['🔎 Cari FWB', '❤️ Matches'],
      ['👤 Profil Saya', '⚙️ Edit Profil']
    ]).resize()
  );
}