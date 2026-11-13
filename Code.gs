/**
 * Дело Ритма — серверная часть сайта на Google Таблице.
 * Вставьте этот файл в Расширения → Apps Script таблицы, запустите setup(),
 * затем опубликуйте как веб-приложение (см. ИНСТРУКЦИЯ.md).
 */

const SH = { SHIFTS: 'Смены', APPS: 'Заявки', TRANSFER: 'Трансфер', KIDS: 'Дети', COACHES: 'Тренеры', WAIT: 'Лист ожидания' };

const SHIFT_HEADERS = ['ID', 'Название', 'Начало', 'Конец', 'Мест всего', 'Цена', 'Возраст', 'Место',
  'Стили (через ;)', 'Тренеры (через ;)', 'Коротко', 'Подробно', 'Программа (через ;)', 'Что входит (через ;)',
  'Цвет', 'Приём заявок', 'Обложка (ссылка на фото)', 'Фото смены (ссылки через ;)', 'Оплата и возврат',
  'Тип (лагерь / тренировка)', 'Закрыть запись за (дней)',
  'Распорядок дня (через ;, например «08:00 Подъём; 09:00 Завтрак»)', 'Кто рядом с детьми (через ;)',
  'Проживание / где проходит', 'Трансфер: откуда и когда', 'Карта (ссылка)',
  'Группы по возрасту (через ;)', 'Связь с ребёнком', 'Что взять с собой (через ;)', 'Видео (ссылка)'];
const DEFAULT_CAPACITY = 50;
const CLOSE_DAYS = { camp: 14, training: 1 }; // за сколько дней до начала закрывается бронь, если в таблице пусто
const COACH_HEADERS = ['Имя', 'Фото (ссылка)', 'Стили', 'О тренере'];
const APP_HEADERS = ['№ заявки', 'Дата заявки', 'ID смены', 'Смена', 'Фамилия ребёнка', 'Имя ребёнка',
  'Дата рождения', 'Возраст', 'Телефон родителя', 'ФИО родителя', 'Тренер', 'Стиль танца', 'Аллергии и запреты',
  'Запреты (старое поле)', 'Трансфер', 'Свидетельство', 'Комментарий', 'Статус', 'ID ребёнка', 'Согласие на обработку ПДн'];
const WAIT_HEADERS = ['Дата', 'ID смены', 'Смена', 'Имя ребёнка', 'Возраст', 'Телефон родителя', 'Комментарий', 'Статус', 'Согласие на обработку ПДн'];
const HOLD_DAYS = 3; // через сколько дней неподтверждённая «Новая» заявка подсвечивается красным
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const TRANSFER_HEADERS = ['№ заявки', 'Смена', 'Даты', 'Фамилия ребёнка', 'Имя ребёнка', 'Телефон родителя', 'Отметка'];
const KID_HEADERS = ['ID ребёнка', 'Фамилия', 'Имя', 'Дата рождения', 'Телефон родителя', 'ФИО родителя',
  'Тренер', 'Стиль', 'Аллергии', 'Запреты', 'Свидетельство', 'Последняя заявка', 'Смен всего'];

// Колонки «Заявок» (с нуля)
const A = { NUM: 0, SHIFT_ID: 2, LAST: 4, FIRST: 5, AGE: 7, PHONE: 8, COACH: 10, STYLE: 11, ALLERGY: 12, RESTR: 13, TRANSFER: 14, STATUS: 17, KID: 18 };
const CANCELLED = 'Отменена';
const CERT_LATER = 'Пришлют позже';
const TZ = () => Session.getScriptTimeZone();

/* ================= Веб-приложение ================= */

function doGet(e) {
  try {
    const p = e.parameter || {};
    if (!p.action || p.action === 'shifts') return out({ ok: true, shifts: getShifts(), coaches: getCoaches() });
    return out({ ok: false, error: 'Неизвестное действие' });
  } catch (err) {
    return out({ ok: false, error: String(err.message || err) });
  }
}

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (d.action === 'book') { limit('b' + normPhone(d.phone), 12); return out(book(d)); }
    if (d.action === 'waitlist') { limit('w' + normPhone(d.phone), 6); return out(waitlist(d)); }
    if (d.action === 'adminLogin') return out(adminLogin(d));
    if (/^admin/.test(d.action || '')) {
      if (!adminOk(d.token)) return out({ ok: false, auth: false, error: 'Войдите заново' });
      if (d.action === 'adminList') return out(adminList());
      if (d.action === 'adminSave') return out(adminSave(d.shift || {}));
      if (d.action === 'adminDelete') return out(adminDelete(d.id));
    }
    return out({ ok: false, error: 'Неизвестное действие' });
  } catch (err) {
    return out({ ok: false, error: String(err.message || err) });
  }
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ================= Смены ================= */

function getShifts() {
  const rows = sheet(SH.SHIFTS).getDataRange().getValues().slice(1).filter(r => r[0]);
  const taken = takenByShift();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const list = s => String(s || '').split(';').map(x => x.trim()).filter(Boolean);
  return rows.map(r => {
    const type = /трен/i.test(String(r[19])) ? 'training' : 'camp';
    const cd = String(r[20]).trim() === '' ? CLOSE_DAYS[type] : Number(r[20]);
    return {
    id: String(r[0]).trim(), title: r[1], start: dateIso(r[2]), end: dateIso(r[3] || r[2]), type: type, closeDays: cd,
    capacity: Number(r[4]) || DEFAULT_CAPACITY, taken: taken[String(r[0]).trim()] || 0, price: Number(r[5]) || 0,
    ages: r[6], place: r[7], styles: list(r[8]), coaches: list(r[9]), short: r[10], long: r[11],
    program: list(r[12]), included: list(r[13]), color: String(r[14] || '').trim(),
    open: !/^нет$/i.test(String(r[15]).trim()),
    cover: imgUrl(r[16]), photos: list(r[17]).map(imgUrl), payment: String(r[18] || ''),
    schedule: list(r[21]), staff: list(r[22]), living: String(r[23] || ''), transferInfo: String(r[24] || ''), mapUrl: String(r[25] || '').trim(),
    groups: list(r[26]), contact: String(r[27] || ''), packing: list(r[28]), video: String(r[29] || '').trim()
  }; }).filter(s => s.type === 'camp' && s.end && parseIso(s.end) >= today);
}

/** Все тренеры студии — для блока «Тренеры» и выбора в анкете. */
function getCoaches() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SH.COACHES);
  if (!sh) return [];
  return sh.getDataRange().getValues().slice(1).filter(r => String(r[0]).trim())
    .map(r => ({ name: String(r[0]).trim(), photo: imgUrl(r[1]), styles: String(r[2] || ''), bio: String(r[3] || '') }));
}

/** Ссылку «Поделиться» с Google Диска превращаем в прямую ссылку на картинку. Файл должен быть открыт по ссылке. */
function imgUrl(v) {
  const s = String(v || '').trim();
  const m = s.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]{20,})/);
  return m ? 'https://lh3.googleusercontent.com/d/' + m[1] : s;
}

function takenByShift() {
  const res = {};
  sheet(SH.APPS).getDataRange().getValues().slice(1).forEach(r => {
    if (r[A.SHIFT_ID] && r[A.STATUS] !== CANCELLED) res[r[A.SHIFT_ID]] = (res[r[A.SHIFT_ID]] || 0) + 1;
  });
  return res;
}

/* ================= Бронирование ================= */

function book(d) {
  const need = { shiftId: 'смена', phone: 'телефон', lastName: 'фамилия', firstName: 'имя', birthDate: 'дата рождения',
    coach: 'тренер', style: 'стиль танца', allergies: 'аллергии и запреты' };
  for (const k in need) if (!String(d[k] || '').trim()) return { ok: false, error: 'Не заполнено поле: ' + need[k] };
  if (d.consent !== true) return { ok: false, error: 'Нужно согласие на обработку персональных данных' };
  const phone = normPhone(d.phone);
  if (phone.length !== 11) return { ok: false, error: 'Проверьте номер телефона' };
  const lastName = String(d.lastName || '').trim(), firstName = String(d.firstName || '').trim();
  const birth = parseDateIso(d.birthDate);
  if (!birth) return { ok: false, error: 'Проверьте дату рождения' };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const shift = getShifts().find(s => s.id === d.shiftId);
    if (!shift) return { ok: false, error: 'Смена не найдена' };
    if (!shift.open) return { ok: false, error: 'Запись на эту смену закрыта' };
    if (shift.taken >= shift.capacity) return { ok: false, error: 'Места закончились. Напишите администратору — он подскажет, не освободилось ли место' };
    const closeAt = parseIso(shift.start); closeAt.setDate(closeAt.getDate() - shift.closeDays);
    if (new Date() >= closeAt) return { ok: false, error: 'Бронирование закрыто. Напишите администратору — он подскажет, не освободилось ли место' };
    const isCamp = shift.type === 'camp';
    const age = ageAt(birth, parseIso(shift.start));
    if (!ageFits(shift.ages, age)) return { ok: false, error: 'Возраст ребёнка не подходит для этой смены' };

    // Ребёнок в базе
    const kids = sheet(SH.KIDS), kidRows = kids.getDataRange().getValues();
    let kidRow = -1;
    for (let i = 1; i < kidRows.length; i++) {
      const r = kidRows[i];
      if (normPhone(r[4]) === phone && low(r[1]) === low(lastName) && low(r[2]) === low(firstName)) { kidRow = i; break; }
    }
    const kidId = kidRow > 0 ? kidRows[kidRow][0] : 'K-' + Utilities.getUuid().slice(0, 8);

    // Повторная заявка на ту же смену
    const apps = sheet(SH.APPS);
    const dup = apps.getDataRange().getValues().slice(1)
      .some(r => r[A.KID] === kidId && r[A.SHIFT_ID] === shift.id && r[A.STATUS] !== CANCELLED);
    if (dup) return { ok: false, error: d.firstName + ' уже записан(а) на эту смену' };

    // Свидетельство
    let cert = kidRow > 0 ? kidRows[kidRow][10] : '';
    if (d.file && d.file.data) cert = saveFile(d.file, lastName + ' ' + firstName);
    if (!cert && isCamp) {
      if (!d.certLater) return { ok: false, error: 'Прикрепите фото свидетельства о рождении или выберите «Пришлю позже»' };
      cert = CERT_LATER;
    }
    const transfer = isCamp && !!d.transfer;

    const num = 'ДР-' + String(apps.getLastRow()).padStart(4, '0');
    const phonePretty = prettyPhone(phone);
    const dates = shift.start === shift.end ? fmtDate(parseIso(shift.start)) : fmtDate(parseIso(shift.start)) + ' — ' + fmtDate(parseIso(shift.end));

    const coach = tidyName(d.coach);
    apps.appendRow([num, new Date(), safeCell(shift.id), safeCell(shift.title), safeCell(lastName), safeCell(firstName), birth, age,
      phonePretty, safeCell(d.parentName), safeCell(coach), safeCell(d.style), safeCell(d.allergies), safeCell(d.restrictions || '—'), isCamp ? (transfer ? 'Да' : 'Нет') : '—',
      cert, safeCell(d.comment), 'Новая', safeCell(kidId), new Date()]);

    if (transfer) sheet(SH.TRANSFER).appendRow([num, safeCell(shift.title), safeCell(dates), safeCell(lastName), safeCell(firstName), phonePretty, '']);

    const kidValues = [safeCell(kidId), safeCell(lastName), safeCell(firstName), birth, phonePretty, safeCell(d.parentName),
      safeCell(coach), safeCell(d.style), safeCell(d.allergies), safeCell(d.restrictions), cert === CERT_LATER ? (kidRow > 0 ? kidRows[kidRow][10] : '') : cert, safeCell(num)];
    if (kidRow > 0) {
      kidValues.push((Number(kidRows[kidRow][12]) || 0) + 1);
      kids.getRange(kidRow + 1, 1, 1, kidValues.length).setValues([kidValues]);
    } else {
      kidValues.push(1);
      kids.appendRow(kidValues);
    }
    notify('🆕 Заявка ' + num + '\n' + shift.title + ' · ' + dates + '\n' + firstName + ' ' + lastName + ', ' + age + ' лет\n' +
      phonePretty + (d.parentName ? ' · ' + d.parentName : '') + '\nТренер: ' + coach + ' · ' + d.style +
      (/^(нет\.?|—|-|)$/i.test(String(d.allergies).trim()) ? '' : '\n⚠️ ' + d.allergies) +
      (cert === CERT_LATER ? '\n📄 Свидетельство пришлют позже' : '') + (isCamp ? '\nТрансфер: ' + (transfer ? 'да' : 'нет') : '') +
      (d.comment ? '\n💬 ' + d.comment : '') + '\nМест занято: ' + (shift.taken + 1) + ' из ' + shift.capacity);
    return { ok: true, id: num };
  } finally {
    lock.releaseLock();
  }
}

/* ================= Лист ожидания ================= */
function waitlist(d) {
  const phone = normPhone(d.phone);
  if (phone.length !== 11) return { ok: false, error: 'Проверьте номер телефона' };
  const name = String(d.name || '').trim();
  if (name.length < 2) return { ok: false, error: 'Напишите имя ребёнка' };
  if (d.consent !== true) return { ok: false, error: 'Нужно согласие на обработку персональных данных' };
  const shift = getShifts().find(s => s.id === d.shiftId);
  if (!shift) return { ok: false, error: 'Смена не найдена' };
  const age = Number(d.age);
  if (!Number.isInteger(age) || !ageFits(shift.ages, age)) return { ok: false, error: 'Возраст ребёнка не подходит для этой смены' };
  const sh = sheet(SH.WAIT);
  const dup = sh.getDataRange().getValues().slice(1).some(r => r[1] === shift.id && normPhone(r[5]) === phone && low(r[3]) === low(name));
  const soon = d.kind === 'open';
  if (!dup) sh.appendRow([new Date(), safeCell(shift.id), safeCell(shift.title), safeCell(name), age, prettyPhone(phone), safeCell(d.comment), soon ? 'Ждёт открытия' : 'Ждёт', new Date()]);
  if (!dup) notify((soon ? '🔔 Сообщить об открытии записи\n' : '⏳ Лист ожидания\n') + shift.title + '\n' + name + ', ' + age + ' лет\n' + prettyPhone(phone));
  return { ok: true };
}

/* ================= Кабинет администратора =================
 * Пароль задаётся в «Настройки проекта → Свойства скрипта» как ADMIN_PASSWORD.
 * После входа кабинет получает ключ на 8 часов. */
function adminLogin(d) {
  const pass = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
  if (!pass) return { ok: false, error: 'Пароль кабинета ещё не задан. Добавьте ADMIN_PASSWORD в свойства скрипта (см. инструкцию).' };
  if (String(d.password || '') !== pass) return { ok: false, error: 'Неверный пароль' };
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put('adm_' + token, '1', 28800);
  return { ok: true, token: token, sheetUrl: SpreadsheetApp.getActive().getUrl() };
}
function adminOk(token) {
  if (!token) return false;
  const c = CacheService.getScriptCache();
  if (c.get('adm_' + token) !== '1') return false;
  c.put('adm_' + token, '1', 28800);
  return true;
}
function adminList() {
  const raw = {};
  sheet(SH.SHIFTS).getDataRange().getValues().slice(1).filter(r => r[0]).forEach(r => {
    raw[String(r[0]).trim()] = { closeDaysRaw: String(r[20]).trim(), coverRaw: String(r[16] || ''), coachesRaw: String(r[9] || '') };
  });
  const wait = {};
  const w = SpreadsheetApp.getActive().getSheetByName(SH.WAIT);
  if (w) w.getDataRange().getValues().slice(1).forEach(r => { if (r[1]) wait[r[1]] = (wait[r[1]] || 0) + 1; });
  const shifts = getShifts().map(s => Object.assign(s, raw[s.id] || {}, { waiting: wait[s.id] || 0 }));
  return { ok: true, shifts: shifts, sheetUrl: SpreadsheetApp.getActive().getUrl() };
}
/** Сохранить смену из кабинета: новая строка или правка существующей. Меняются только присланные поля. */
function adminSave(s) {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    // Сайт публикует только лагерные смены: не даём создать устаревший тип «тренировка» через API.
    const type = 'camp';
    if (!String(s.title || '').trim()) return { ok: false, error: 'Напишите название' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s.start || ''))) return { ok: false, error: 'Укажите дату начала' };
    if (type === 'camp' && s.end && s.end < s.start) return { ok: false, error: 'Дата окончания раньше начала' };
    const sh = sheet(SH.SHIFTS), all = sh.getDataRange().getValues(), N = SHIFT_HEADERS.length;
    let id = String(s.id || '').trim(), idx = id ? all.findIndex((r, i) => i > 0 && String(r[0]).trim() === id) : -1;
    let row;
    if (idx > 0) row = all[idx].slice(0, N);
    else {
      const ids = all.map(r => String(r[0]).trim());
      id = (type === 'camp' ? 'camp-' : 'train-') + s.start; let k = 2;
      while (ids.includes(id)) id = (type === 'camp' ? 'camp-' : 'train-') + s.start + '-' + k++;
      row = new Array(N).fill('');
      row[0] = id;
    }
    while (row.length < N) row.push('');
    const txt = v => { const t = String(v == null ? '' : v).trim(); return /^[=+\-@]/.test(t) ? "'" + t : t; };
    const lines = v => (Array.isArray(v) ? v : String(v || '').split(/\n|;/)).map(x => String(x).trim()).filter(Boolean).map(txt).join('; ');
    const has = k => Object.prototype.hasOwnProperty.call(s, k);
    row[1] = txt(s.title);
    row[2] = parseIso(s.start);
    row[3] = type === 'camp' && s.end ? parseIso(s.end) : '';
    row[19] = type === 'camp' ? 'лагерь' : 'тренировка';
    if (has('capacity')) row[4] = Number(s.capacity) || DEFAULT_CAPACITY;
    if (has('price')) row[5] = Number(s.price) || 0;
    if (has('ages')) row[6] = txt(s.ages);
    if (has('place')) row[7] = txt(s.place);
    if (has('styles')) row[8] = lines(s.styles);
    if (has('coaches')) row[9] = lines(s.coaches);
    if (has('short')) row[10] = txt(s.short);
    if (has('long')) row[11] = txt(s.long);
    if (has('program')) row[12] = lines(s.program);
    if (has('included')) row[13] = lines(s.included);
    if (has('open')) row[15] = s.open ? 'да' : 'нет';
    if (has('closeDays')) row[20] = s.closeDays === '' || s.closeDays == null ? '' : Number(s.closeDays);
    if (has('schedule')) row[21] = lines(s.schedule);
    if (has('staff')) row[22] = lines(s.staff);
    if (has('living')) row[23] = txt(s.living);
    if (has('groups')) row[26] = lines(s.groups);
    if (has('contact')) row[27] = txt(s.contact);
    if (has('packing')) row[28] = lines(s.packing);
    if (has('video')) row[29] = txt(s.video);
    if (s.poster && /^data:image\//.test(s.poster)) row[16] = savePoster(s.poster, row[1] + ' ' + s.start);
    else if (s.removePoster) row[16] = '';
    if (idx > 0) sh.getRange(idx + 1, 1, 1, N).setValues([row]);
    else sh.appendRow(row);
    if (sh.getLastRow() > 2) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).sort({ column: 3, ascending: true });
    return { ok: true, id: id, cover: imgUrl(row[16]) };
  } finally { lock.releaseLock(); }
}
function adminDelete(id) {
  id = String(id || '').trim();
  const n = takenByShift()[id] || 0;
  if (n) return { ok: false, error: 'На эту смену уже записались ' + n + ' — удалить нельзя. Выключите запись, и смена останется на сайте без кнопки.' };
  const sh = sheet(SH.SHIFTS), all = sh.getDataRange().getValues();
  const idx = all.findIndex((r, i) => i > 0 && String(r[0]).trim() === id);
  if (idx < 1) return { ok: false, error: 'Смена не найдена' };
  sh.deleteRow(idx + 1);
  return { ok: true };
}
/** Постер: сохраняем в папку «Дело Ритма — постеры» и открываем по ссылке, чтобы сайт мог показать картинку. */
function savePoster(dataUrl, title) {
  const m = String(dataUrl).match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
  if (!m) throw new Error('Не удалось прочитать картинку');
  if (!/^image\/(jpeg|png|webp)$/.test(m[1])) throw new Error('Постер должен быть в формате JPG, PNG или WebP');
  if (base64Bytes(m[2]) > MAX_FILE_BYTES) throw new Error('Постер больше 5 МБ. Сожмите изображение и попробуйте ещё раз');
  const ext = m[1] === 'image/png' ? '.png' : m[1] === 'image/webp' ? '.webp' : '.jpg';
  const f = posterFolder().createFile(Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], 'Постер — ' + safeFileName(title) + ext));
  f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return 'https://drive.google.com/file/d/' + f.getId() + '/view';
}
function posterFolder() {
  const props = PropertiesService.getScriptProperties(), id = props.getProperty('POSTER_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = DriveApp.createFolder('Дело Ритма — постеры смен');
  props.setProperty('POSTER_FOLDER_ID', f.getId());
  return f;
}

/* ================= Уведомления в Telegram =================
 * Свойства скрипта (Настройки проекта → Свойства скрипта):
 *   TG_TOKEN — токен бота от @BotFather, TG_CHAT — id чата администратора или группы.
 * Если свойства не заданы, уведомления просто не отправляются. */
function notify(text) {
  const p = PropertiesService.getScriptProperties(), token = p.getProperty('TG_TOKEN'), chat = p.getProperty('TG_CHAT');
  if (!token || !chat) return;
  try {
    UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ chat_id: chat, text: text, disable_web_page_preview: true })
    });
  } catch (e) { /* заявка важнее уведомления */ }
}
/** Запустите вручную, чтобы проверить, что бот пишет в нужный чат. */
function testNotify() { notify('✅ Уведомления сайта «Дело Ритма» работают'); }

/** Защита от спама: не больше max запросов с одного номера за 10 минут. */
function limit(key, max) {
  const c = CacheService.getScriptCache(), n = Number(c.get(key) || 0);
  if (n >= max) throw new Error('Слишком много попыток. Подождите 10 минут или напишите администратору');
  c.put(key, String(n + 1), 600);
}

function tidyName(v) {
  const s = String(v || '').trim().replace(/\s+/g, ' ');
  if (/^пока/i.test(s)) return s;
  return s.split(' ').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
}

function saveFile(f, title) {
  const m = String(f.data).match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error('Не удалось прочитать файл');
  if (!/^(image\/(jpeg|png)|application\/pdf)$/.test(m[1])) throw new Error('Допустимы только JPG, PNG или PDF');
  if (base64Bytes(m[2]) > MAX_FILE_BYTES) throw new Error('Файл больше 5 МБ. Сожмите его или выберите другой');
  const ext = m[1] === 'application/pdf' ? '.pdf' : m[1] === 'image/png' ? '.png' : '.jpg';
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], safeFileName(title) + ' — свидетельство' + ext);
  return folder().createFile(blob).getUrl(); // файл остаётся приватным: видят только владельцы папки
}

function folder() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = DriveApp.createFolder('Дело Ритма — свидетельства о рождении');
  props.setProperty('FOLDER_ID', f.getId());
  return f;
}

/* ================= Меню и списки ================= */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Дело Ритма')
    .addItem('Сформировать списки по сменам', 'buildLists')
    .addItem('Проверить уведомления в Telegram', 'testNotify')
    .addSeparator()
    .addItem('Первоначальная настройка', 'setup')
    .addToUi();
}

/** Для каждой смены создаёт (или обновляет) вкладку «Список · …» — состав группы для вожатых и тренеров. */
function buildLists() {
  const ss = SpreadsheetApp.getActive();
  const apps = sheet(SH.APPS).getDataRange().getValues().slice(1).filter(r => r[A.STATUS] !== CANCELLED);
  const head = ['№', 'Фамилия', 'Имя', 'Возраст', 'Тренер', 'Стиль', 'Аллергии и запреты', 'Запреты (старое)', 'Телефон родителя', 'Трансфер', '№ заявки', 'Статус', 'Свидетельство'];
  const shifts = sheet(SH.SHIFTS).getDataRange().getValues().slice(1).filter(r => r[0]);
  shifts.forEach(s => {
    const rows = apps.filter(r => r[A.SHIFT_ID] === String(s[0]).trim())
      .sort((a, b) => String(a[A.LAST]).localeCompare(String(b[A.LAST]), 'ru'))
      .map((r, i) => [i + 1, r[A.LAST], r[A.FIRST], r[A.AGE], r[A.COACH], r[A.STYLE], r[A.ALLERGY], r[A.RESTR], r[A.PHONE], r[A.TRANSFER], r[A.NUM], r[A.STATUS], r[15] === CERT_LATER ? 'нужно прислать' : (r[15] ? 'есть' : '—')]);
    const name = ('Список · ' + s[1]).slice(0, 90);
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.clear();
    sh.getRange(1, 1).setValue(s[1] + ' · ' + fmtDate(s[2]) + ' — ' + fmtDate(s[3]) + ' · детей: ' + rows.length).setFontWeight('bold').setFontSize(13);
    sh.getRange(2, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#E6EAEE');
    if (rows.length) sh.getRange(3, 1, rows.length, head.length).setValues(rows);
    sh.setFrozenRows(2);
    sh.autoResizeColumns(1, head.length);
    // подсвечиваем детей с аллергиями и запретами
    rows.forEach((r, i) => {
      const none = v => /^(нет\.?|—|-|)$/i.test(String(v).trim());
      if (!none(r[6]) || !none(r[7]))
        sh.getRange(i + 3, 7, 1, 2).setBackground('#FFF0B8');
      if (r[12] === 'нужно прислать') sh.getRange(i + 3, 13).setBackground('#FFE3C2');
    });
  });
  SpreadsheetApp.getActive().toast('Списки обновлены: ' + shifts.length);
}

/** Создаёт вкладки с заголовками, примеры смен и папку для свидетельств. Можно запускать повторно. */
function setup() {
  const ss = SpreadsheetApp.getActive();
  const make = (name, headers, color) => {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground(color).setWrap(true);
    sh.setFrozenRows(1);
    return sh;
  };
  const shifts = make(SH.SHIFTS, SHIFT_HEADERS, '#FFF0B8');
  const apps = make(SH.APPS, APP_HEADERS, '#DDF0FC');
  make(SH.TRANSFER, TRANSFER_HEADERS, '#E6EAEE');
  const wait = make(SH.WAIT, WAIT_HEADERS, '#E9E2FF');
  wait.getRange('A:A').setNumberFormat('dd.mm.yyyy hh:mm'); wait.getRange('F:F').setNumberFormat('@');
  wait.getRange('H2:H').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['Ждёт', 'Ждёт открытия', 'Сообщили', 'Предложили место', 'Записан', 'Отказ']).build());
  const kids = make(SH.KIDS, KID_HEADERS, '#E6EAEE');
  const coaches = make(SH.COACHES, COACH_HEADERS, '#FFF0B8');
  apps.getRange('I:I').setNumberFormat('@'); kids.getRange('E:E').setNumberFormat('@');
  apps.getRange('B:B').setNumberFormat('dd.mm.yyyy hh:mm'); apps.getRange('G:G').setNumberFormat('dd.mm.yyyy');
  kids.getRange('D:D').setNumberFormat('dd.mm.yyyy'); shifts.getRange('C:D').setNumberFormat('dd.mm.yyyy');
  apps.getRange('R2:R').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['Новая', 'Подтверждена', 'Оплачена', CANCELLED]).build());
  // Цвета: статус заявки, просроченная «Новая» (не подтвердили за HOLD_DAYS дня), аллергии, свидетельство «позже»
  const R = (f, color, range) => SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(f).setBackground(color).setRanges([apps.getRange(range)]).build();
  apps.setConditionalFormatRules([
    R('=AND($R2="Новая",NOW()-$B2>' + HOLD_DAYS + ')', '#FBD5D5', 'A2:S'),
    R('=$R2="Подтверждена"', '#E3F4E8', 'R2:R'),
    R('=$R2="Оплачена"', '#C9EBD3', 'R2:R'),
    R('=$R2="' + CANCELLED + '"', '#E6EAEE', 'A2:S'),
    R('=AND($M2<>"",NOT(REGEXMATCH(LOWER($M2),"^(нет\\.?|—|-)$")))', '#FFF0B8', 'M2:M'),
    R('=$P2="' + CERT_LATER + '"', '#FFE3C2', 'P2:P')
  ]);

  if (coaches.getLastRow() < 2) {
    coaches.getRange(2, 1, 3, 4).setValues([
      ['Алина Мельникова', '', 'Хип-хоп, вог', 'Ставит номера для отчётных концертов, ведёт старшие группы.'],
      ['Даня Ким', '', 'Брейкинг, локинг', 'Бибой. Отвечает за безопасную технику пауэрмувов.'],
      ['Вероника Лаптева', '', 'Джаз-фанк, контемп', 'Хореограф-постановщик, готовит детей к сцене.']
    ]);
  }
  const pay = 'Бронь держим 3 дня. Предоплата 30%, остаток — за 14 дней до смены. При отмене за 14 дней и раньше возвращаем всю сумму.';
  if (shifts.getLastRow() < 2) {
    const d = s => parseIso(s);
    shifts.getRange(2, 1, 2, SHIFT_HEADERS.length).setValues([
      ['camp-dec', 'Зимняя смена', d('2026-12-04'), d('2026-12-07'), 50, 22000, '7–16', '«Жемчужина Сибири», Тюмень',
        'Хип-хоп; Хаус; Брейкинг', 'Тимур Ахмедов; Даня Ким; Алина Мельникова',
        'Четыре дня танцев за городом: тренировки, баттл и концерт для родителей.',
        'Тренировки дважды в день, группы по возрасту и уровню. Командные номера, баттл и отчётный концерт.',
        'Две тренировки в день; Баттл; Вечерние мероприятия; Концерт для родителей',
        'Проживание; Питание; Трансфер; Медработник 24/7', 'sun', 'да', '', '', pay, 'лагерь', '',
        '08:00 Подъём и зарядка; 09:00 Завтрак; 10:00 Тренировка; 13:00 Обед; 14:00 Свободное время; 16:00 Тренировка; 19:00 Ужин; 20:00 Вечернее мероприятие; 22:00 Отбой',
        'Три тренера студии; Вожатый на каждые 10 детей; Медработник на базе круглосуточно',
        'Корпус с комнатами на 3–4 человека, душ в блоке. Пятиразовое питание.', 'Автобус от студии 4 декабря в 9:00, обратно 7 декабря к 18:00.', '',
        '7–9 лет; 10–12 лет; 13–16 лет', 'Телефоны у детей — вечером, с 20:00 до 21:00. Каждый день фото и видео в чате родителей. Вожатый на связи круглосуточно.',
        'Обувь для зала; Удобная одежда на 2 тренировки в день; Бутылка для воды; Тёплая кофта; Пижама и тапочки; Гигиена; Лекарства — подписать и отдать медработнику', ''],
      ['camp-jan', 'Каникулярная смена', d('2027-01-04'), d('2027-01-07'), 50, 22000, '7–16', '«Жемчужина Сибири», Тюмень',
        'Джаз-фанк; Контемп; Хип-хоп', 'Вероника Лаптева; Даня Ким', 'Ставим номер с хореографом и выступаем на сцене.',
        'Каждая группа ставит номер, работает над подачей и костюмом.',
        'Класс техники; Постановка номера; Выступление', 'Проживание; Питание; Трансфер', 'black', 'да', '', '', pay, 'лагерь', '', '', '', '', '', '', '', '', '', '']
    ]);
  }
  shifts.getRange('T2:T').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['лагерь']).build());
  shifts.getRange('O2:O').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['sun', 'sky', 'black', 'graphite']).setAllowInvalid(true).build());
  folder();
  ['Лист1', 'Sheet1'].forEach(n => { const s = ss.getSheetByName(n); if (s && ss.getSheets().length > 1 && s.getLastRow() === 0) ss.deleteSheet(s); });
  ss.toast('Готово: вкладки созданы, папка для свидетельств — в вашем Google Диске');
}

/* ================= Утилиты ================= */

function sheet(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('Нет вкладки «' + name + '». Запустите setup()');
  return sh;
}
function normPhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  return d;
}
function prettyPhone(d) { return '+' + d[0] + ' ' + d.slice(1, 4) + ' ' + d.slice(4, 7) + '-' + d.slice(7, 9) + '-' + d.slice(9); }
function low(s) { return String(s || '').trim().toLowerCase().replace(/ё/g, 'е'); }
function parseIso(s) { const p = String(s).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
function parseDateIso(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null;
}
function ageRange(v) {
  const m = String(v || '').match(/(\d{1,2})\s*(?:[-–—]\s*(\d{1,2}))?/);
  if (!m) return null;
  const min = Number(m[1]), max = Number(m[2] || m[1]);
  return min <= max ? { min: min, max: max } : null;
}
function ageFits(ages, age) {
  const r = ageRange(ages);
  return Number.isInteger(age) && (!r || (age >= r.min && age <= r.max));
}
function safeCell(v) {
  const s = String(v == null ? '' : v).trim();
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
function safeFileName(v) { return String(v || 'Документ').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Документ'; }
function base64Bytes(v) { return Math.floor(String(v || '').replace(/=+$/, '').length * 3 / 4); }
function dateIso(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ(), 'yyyy-MM-dd');
  const s = String(v || '').trim(), m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m ? m[3] + '-' + m[2] + '-' + m[1] : s;
}
function fmtDate(v) { return v instanceof Date ? Utilities.formatDate(v, TZ(), 'dd.MM.yyyy') : String(v); }
function ageAt(birth, at) {
  let a = at.getFullYear() - birth.getFullYear();
  if (at.getMonth() < birth.getMonth() || (at.getMonth() === birth.getMonth() && at.getDate() < birth.getDate())) a--;
  return a;
}
