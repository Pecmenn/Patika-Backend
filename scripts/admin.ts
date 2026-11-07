// Yönetici hesapları: npm run admin -- create <e-posta> | password <e-posta> | list | remove <e-posta>
// Şifre komuta yazılmaz, sorulur: komut geçmişinde kalmasın. Yazarken ekranda görünmez.
import { randomUUID } from 'node:crypto';
import { stdin, stdout } from 'node:process';

import { hashPassword } from '../src/auth/passwords.ts';
import { createDb, isDuplicateKey } from '../src/db.ts';

const MIN_PASSWORD = 12;

const [command, rawEmail] = process.argv.slice(2);
const email = rawEmail?.trim().toLowerCase();
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL ayarlanmamış');
}
const db = createDb(url);

// Boru ile gelen girdi (test) satır satır okunur, gerçek terminalde yazılan gizlenir.
let pipedLines: string[] | null = null;
// Yapıştırılan metinde Enter'dan sonra kalan tuşlar sonraki soruya aittir, atılmaz.
let leftover = '';

async function askHidden(question: string) {
  if (!stdin.isTTY) {
    pipedLines ??= (await new Response(stdin as unknown as ReadableStream).text()).split(/\r?\n/);
    return pipedLines.shift() ?? '';
  }
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  return new Promise<string>((resolve) => {
    let typed = '';
    const onData = (chunk: string) => {
      for (let index = 0; index < chunk.length; index += 1) {
        const char = chunk[index];
        if (char === '\r' || char === '\n') {
          leftover = chunk.slice(index + 1).replace(/^\n/, '');
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          resolve(typed);
          return;
        }
        if (char === '\u0003') {
          stdout.write('\n');
          process.exit(1);
        }
        if (char === '\u007f' || char === '\b') {
          typed = typed.slice(0, -1);
        } else {
          typed += char;
        }
      }
    };
    stdin.on('data', onData);
    stdin.resume();
    if (leftover) {
      const pending = leftover;
      leftover = '';
      onData(pending);
    }
  });
}

async function askNewPassword() {
  const password = await askHidden(`Yeni şifre (en az ${MIN_PASSWORD} karakter): `);
  if (password.length < MIN_PASSWORD) {
    throw new Error(`Şifre en az ${MIN_PASSWORD} karakter olmalı`);
  }
  if ((await askHidden('Şifreyi yeniden yaz: ')) !== password) {
    throw new Error('İki şifre aynı değil');
  }
  return hashPassword(password);
}

function requireEmail() {
  if (!email?.includes('@')) {
    throw new Error('E-posta gerekli');
  }
  return email;
}

try {
  if (command === 'create') {
    const address = requireEmail();
    const passwordHash = await askNewPassword();
    try {
      await db
        .insertInto('admins')
        .values({ id: randomUUID(), email: address, password_hash: passwordHash })
        .execute();
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new Error('Bu e-postayla yönetici var. Şifreyi değiştirmek için: password');
      }
      throw error;
    }
    console.log(`Yönetici açıldı: ${address}`);
  } else if (command === 'password') {
    const address = requireEmail();
    const admin = await db.selectFrom('admins').select('id').where('email', '=', address).executeTakeFirst();
    if (!admin) {
      throw new Error('Bu e-postayla yönetici yok');
    }
    const passwordHash = await askNewPassword();
    await db.transaction().execute(async (trx) => {
      await trx.updateTable('admins').set({ password_hash: passwordHash }).where('id', '=', admin.id).execute();
      // Eski şifreyle açılmış oturumlar kapanır.
      await trx.deleteFrom('admin_sessions').where('admin_id', '=', admin.id).execute();
    });
    console.log(`Şifre değişti, açık oturumlar kapandı: ${address}`);
  } else if (command === 'list') {
    console.table(await db.selectFrom('admins').select(['email', 'created_at']).orderBy('created_at').execute());
  } else if (command === 'remove') {
    const address = requireEmail();
    const { numDeletedRows } = await db.deleteFrom('admins').where('email', '=', address).executeTakeFirst();
    console.log(numDeletedRows > 0n ? `Yönetici silindi: ${address}` : 'Bu e-postayla yönetici yok');
  } else {
    console.log('Kullanım: npm run admin -- create <e-posta> | password <e-posta> | list | remove <e-posta>');
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await db.destroy();
  // Windows'ta bekleyen okuma işlemi canlı tutar: komut işi bitince kapanmayabilir.
  stdin.destroy();
}
