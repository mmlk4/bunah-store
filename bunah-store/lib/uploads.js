'use strict';
// Saves uploaded images to Vercel Blob when BLOB_READ_WRITE_TOKEN is set,
// otherwise to the local uploads folder. Returns the public URL.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'public', 'uploads');
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

// verify the real file signature, not just the declared mimetype
function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'image/png';
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

async function saveUpload(file) {
  if (!file || !file.buffer) return null;
  const type = sniff(file.buffer);
  if (!type) return null;
  const name = Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex') + EXT[type];
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const { put } = require('@vercel/blob');
    const r = await put('uploads/' + name, file.buffer, { access: 'public', contentType: type, addRandomSuffix: false });
    return r.url;
  }
  if (process.env.VERCEL) throw new Error('تخزين الصور غير مربوط: أضف Blob من تبويب Storage في Vercel ثم أعد النشر (BLOB_READ_WRITE_TOKEN مفقود).');
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, name), file.buffer);
  return '/uploads/' + name;
}

module.exports = { saveUpload, UPLOAD_DIR };
