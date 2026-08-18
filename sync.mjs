#!/usr/bin/env node
/**
 * Раскладывает общие файлы по сервисам.
 *
 *   node Shared/sync.mjs           разложить
 *   node Shared/sync.mjs --check   только проверить, что копии не разъехались
 *
 * Зачем копии, а не одна ссылка. Docker собирает образ из каталога сервиса и
 * наружу выйти не может: `COPY ../Shared/brand.css` невозможен физически.
 * Значит вариантов два — либо тянуть стили по сети с auth-домена (тогда чужой
 * сервис перестаёт краситься, когда auth недоступен, и каждая страница ждёт
 * лишний кросс-доменный запрос), либо держать копии и раскладывать их машинально.
 * Выбрано второе: редактируется по-прежнему одно место, а сервисы остаются
 * самодостаточными.
 *
 * Правило: в assets/ сервиса эти файлы НЕ редактируют. Правка уедет при
 * следующей раскладке. Меняем в Shared/ и запускаем этот скрипт.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const SRC = path.join(ROOT, "Shared");

/**
 * Куда и что кладём. Новый сервис — строчка сюда (или две: assets и корень
 * не обязаны совпадать). dir не обязан быть assets/ — admin-internal.js и
 * set-env.sh лежат прямо в корне сервиса, рядом с server.js/docker-compose.
 */
const TARGETS = [
  { name: "Вход",        dir: "Auth/assets",    files: ["brand.css", "brand.js"] },
  { name: "Мои финансы", dir: "Финансы/assets", files: ["brand.css", "brand.js"] },
  { name: "Куда поедем?",   dir: "Trip/assets",   files: ["brand.css", "brand.js"] },
  { name: "Что смотрим?",   dir: "Movies/assets", files: ["brand.css", "brand.js"] },
  { name: "Админка",     dir: "Admin/assets",   files: ["brand.css", "brand.js"] },
  { name: "Главная",     dir: "Home/assets",    files: ["brand.css", "brand.js"] },
  { name: "Пораскинем мозгами?", dir: "Brain/assets", files: ["brand.css", "brand.js"] },

  // Серверные/операционные файлы — не в assets/, а в корне рядом с server.js.
  // Docker их не задевает: admin-internal.js попадает в образ явным COPY (или
  // маской *.js) как и раньше, а set-env.sh в образ вообще не нужен — это
  // хостовый скрипт для .env рядом с docker-compose.prod.yml.
  { name: "Вход (корень)",        dir: "Auth",    files: ["admin-internal.js", "set-env.sh"] },
  { name: "Мои финансы (корень)", dir: "Финансы", files: ["admin-internal.js", "set-env.sh"] },
  { name: "Куда поедем? (корень)",   dir: "Trip",   files: ["admin-internal.js", "set-env.sh"] },
  { name: "Что смотрим? (корень)",   dir: "Movies", files: ["admin-internal.js", "set-env.sh"] },
  { name: "Админка (корень)",     dir: "Admin",   files: ["set-env.sh"] }, // не callee /internal/* — admin-internal.js не нужен
];

const BANNER = {
  ".css": (f) => `/* Копия Shared/${f} — не редактировать здесь.\n   Правки вносят в Shared/ и раскладывают: node Shared/sync.mjs */\n`,
  ".js":  (f) => `// Копия Shared/${f} — не редактировать здесь.\n// Правки вносят в Shared/ и раскладывают: node Shared/sync.mjs\n`,
  // Без своего "#!" — вставляется ПОСЛЕ шебанга исходника (см. buildContent),
  // а не перед ним: два "#!" подряд в шебанг-строке не годятся.
  ".sh":  (f) => `# Копия Shared/${f} — не редактировать здесь.\n# Правки вносят в Shared/ и раскладывают: node Shared/sync.mjs\n`,
};

/** Банер после шебанга, если он есть, иначе перед всем содержимым. */
function buildContent(banner, source) {
  if (banner && source.startsWith("#!")) {
    const afterShebang = source.indexOf("\n") + 1;
    return source.slice(0, afterShebang) + banner + source.slice(afterShebang);
  }
  return banner + source;
}

const check = process.argv.includes("--check");
let changed = 0, missing = 0;

for (const target of TARGETS) {
  const dir = path.join(ROOT, target.dir);
  if (!fs.existsSync(dir)) {
    console.log(`  пропуск  ${target.dir} — каталога нет`);
    continue;
  }
  for (const file of target.files) {
    const src = path.join(SRC, file);
    if (!fs.existsSync(src)) {
      console.error(`  НЕТ ИСХОДНИКА  Shared/${file}`);
      missing++;
      continue;
    }
    const ext = path.extname(file);
    const banner = (BANNER[ext] || (() => ""))(file);
    const want = buildContent(banner, fs.readFileSync(src, "utf8"));
    const dest = path.join(dir, file);
    const have = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : null;

    // Сравниваем, приведя переводы строк к общему виду. На Windows git сам
    // переводит рабочую копию в CRLF (core.autocrlf), и побайтовое сравнение
    // начинало бы кричать о расхождении после каждого clone, checkout или
    // stash — при полностью одинаковом содержимом. Хук, который врёт, быстро
    // приучает жать --no-verify, и тогда он бесполезен.
    const eol = s => (s === null ? null : s.replace(/\r\n/g, "\n"));

    if (eol(have) === eol(want)) {
      console.log(`  совпадает  ${target.dir}/${file}`);
      continue;
    }
    changed++;
    if (check) {
      console.error(`  РАЗЪЕХАЛОСЬ  ${target.dir}/${file}`);
    } else {
      fs.writeFileSync(dest, want);
      if (ext === ".sh") fs.chmodSync(dest, 0o755); // set-env.sh запускают и как ./set-env.sh
      console.log(`  ${have === null ? "создан  " : "обновлён"}  ${target.dir}/${file}`);
    }
  }
}

if (missing) process.exit(2);
if (check && changed) {
  console.error(`\nКопий разъехалось: ${changed}. Выполните: node Shared/sync.mjs`);
  process.exit(1);
}
console.log(check ? "\nВсё на месте." : `\nГотово, обновлено файлов: ${changed}.`);
