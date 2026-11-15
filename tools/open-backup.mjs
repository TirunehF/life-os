#!/usr/bin/env node
// Open an encrypted Life OS backup without the app.
//
//   node tools/open-backup.mjs life-os-backup-2026-01-04-1830.json             prints the export
//   node tools/open-backup.mjs life-os-backup-2026-01-04-1830.json out.json    writes it to a file
//
// It asks for the password the backup was saved with. The result is the same
// JSON as "Export everything", which Settings can import again. Needs Node 18
// or newer and nothing else. docs/data-format.md describes the file.
import {pbkdf2Sync, createDecipheriv} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/** The text inside a backup. Throws when the password does not fit. */
export function openBackup(envelope, password) {
  const iterations = Number(envelope && envelope.iterations);
  if (!envelope || envelope.lifeos_backup !== 1 || envelope.kdf !== 'PBKDF2-HMAC-SHA256' ||
      envelope.cipher !== 'AES-256-GCM' || !(iterations >= 1 && iterations <= 10000000)) {
    throw new Error('This is not a Life OS backup that this tool understands.');
  }
  const key = pbkdf2Sync(Buffer.from(password, 'utf8'), Buffer.from(envelope.salt, 'base64'), iterations, 32, 'sha256');
  const data = Buffer.from(envelope.data, 'base64');       // ciphertext, then the 16-byte tag
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(data.subarray(data.length - 16));
  try {
    return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString('utf8');
  } catch (e) {
    throw new Error('That password does not open this backup.');
  }
}

/* Read a password from the terminal without showing it (or one line from a pipe). */
function askPassword(prompt) {
  return new Promise(resolve => {
    const stdin = process.stdin;
    stdin.setEncoding('utf8');
    if (!stdin.isTTY) {
      let text = '';
      stdin.on('data', chunk => { text += chunk; });
      stdin.on('end', () => resolve(text.replace(/\r?\n[\s\S]*$/, '')));
      return;
    }
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    let password = '';
    const done = () => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stderr.write('\n'); };
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') { done(); resolve(password); return; }
        if (ch === '\u0003') { done(); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') password = password.slice(0, -1);
        else password += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const [file, out] = process.argv.slice(2);
  if (!file || file === '-h' || file === '--help') {
    console.error('Usage: node tools/open-backup.mjs <backup file> [output file]');
    process.exit(file ? 0 : 1);
  }
  let envelope;
  try { envelope = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { console.error('Could not read ' + file + ' as a backup file.'); process.exit(1); }
  let text;
  try { text = openBackup(envelope, await askPassword('Password of this backup: ')); }
  catch (e) { console.error(e.message); process.exit(1); }
  if (out) {
    writeFileSync(out, text, {mode: 0o600});
    console.error('Written to ' + out + ' (saved ' + (envelope.created || 'at an unknown time') + ').');
  } else {
    process.stdout.write(text + '\n');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
