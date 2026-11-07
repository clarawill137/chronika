// Хроника — поиск по истории чата и памяти STMB как инструмент (function calling) для модели.
// Модель сама решает, когда ей нужна старая деталь, ищет её и читает нужные сообщения.
//
// С расширением «Священный таймлайн»: в чате, отмеченном эпохой, память берётся не из настроек, а из меморибука
// этой эпохи и Хроники мира — и только то, что видно отсюда (на дату сюжета, тому, кто сейчас говорит). Так поиск
// в прошлом не достаёт будущее. Вне эпох — как раньше: лорбуки из настроек.

const MODULE = 'hedyRecall';
const TOOL_SEARCH = 'story_search';
const TOOL_READ = 'story_read';
const OUR_TOOLS = [TOOL_SEARCH, TOOL_READ];

const DEFAULTS = {
    enabled: true,
    lorebooks: '',
    skipLast: 20,
    maxResults: 8,
    compact: true,
    stripTags: 'think,thinking',
};

const ctx = () => SillyTavern.getContext();

function settings() {
    const ext = ctx().extensionSettings;
    if (!ext[MODULE]) ext[MODULE] = {};
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (ext[MODULE][k] === undefined) ext[MODULE][k] = v;
    }
    return ext[MODULE];
}

// ───────────── текст ─────────────

function norm(s) {
    return String(s || '').toLowerCase().replace(/ё/g, 'е');
}

function cleanText(t) {
    let s = String(t || '');
    const tags = settings().stripTags.split(',').map(x => x.trim()).filter(Boolean);
    for (const tag of tags) {
        s = s.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
    }
    return s
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|h\d)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// Грубый стемминг под русский: обрезаем окончание, чтобы «письмо» нашло «письма/письмом».
function stem(w) {
    if (w.length >= 7) return w.slice(0, w.length - 2);
    if (w.length >= 5) return w.slice(0, w.length - 1);
    return w;
}

function parseQuery(q) {
    const raw = String(q || '');
    const phrases = [];
    const rest = raw.replace(/"([^"]{2,})"|«([^»]{2,})»/g, (_, a, b) => {
        phrases.push(norm(a || b).trim());
        return ' ';
    });
    const words = norm(rest)
        .split(/[^\p{L}\p{N}-]+/u)
        .map(w => w.replace(/^-+|-+$/g, ''))
        .filter(w => w.length >= 3);
    const terms = [...new Set([...phrases, ...words.map(stem)])];
    return terms;
}

function countOcc(hay, needle) {
    let n = 0, i = 0;
    while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; if (n > 50) break; }
    return n;
}

function snippet(text, normText, term, radius) {
    const i = normText.indexOf(term);
    if (i === -1) return '';
    let a = Math.max(0, i - radius);
    let b = Math.min(text.length, i + term.length + radius);
    // не резать посреди слова
    while (a > 0 && /\S/.test(text[a - 1]) && i - a < radius + 30) a--;
    while (b < text.length && /\S/.test(text[b]) && b - i < radius + 30) b++;
    return (a > 0 ? '…' : '') + text.slice(a, b).replace(/\s+/g, ' ').trim() + (b < text.length ? '…' : '');
}

// ───────────── источники ─────────────

function chatCorpus() {
    const chat = ctx().chat || [];
    const out = [];
    for (let id = 0; id < chat.length; id++) {
        const m = chat[id];
        if (!m) continue;
        if (m.extra?.tool_invocations) continue; // наши и чужие вызовы инструментов
        const text = cleanText(m.mes);
        if (!text) continue;
        out.push({ id, name: m.name || (m.is_user ? 'User' : '?'), text, ntext: norm(text) });
    }
    return out;
}

const bookCache = new Map();   // имя лорбука → { at, entries } — сырые записи, на минуту

/** Снимок «Священного таймлайна» (эпоха, дата, кто говорит) или null — расширения нет или чат вне мира. */
function timeline() {
    try { return window.SacredTimeline?.context?.() || null; } catch { return null; }
}

/** Откуда брать память: в чате эпохи — её меморибук и Хроника мира; иначе — лорбуки из настроек. */
function memorySources() {
    const cx = timeline();
    if (cx?.explicit) {
        const names = [];
        if (cx.era?.memoryBook) names.push(cx.era.memoryBook);
        if (cx.world?.chronicle && !names.includes(cx.world.chronicle)) names.push(cx.world.chronicle);
        return { cx, names };
    }
    return { cx: null, names: settings().lorebooks.split(',').map(s => s.trim()).filter(Boolean) };
}

async function loadBook(name) {
    const c = ctx();
    try {
        if (typeof c.loadWorldInfo === 'function') {
            const d = await c.loadWorldInfo(name);
            if (d?.entries) return d;
        }
    } catch (e) { /* fallback below */ }
    const res = await fetch('/api/worldinfo/get', {
        method: 'POST',
        headers: c.getRequestHeaders(),
        body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`лорбук «${name}» не загрузился (${res.status})`);
    return await res.json();
}

async function rawEntries(name) {
    const hit = bookCache.get(name);
    if (hit && Date.now() - hit.at < 60_000) return hit.entries;
    const book = await loadBook(name);
    const entries = Object.values(book.entries || {}).filter(Boolean);
    bookCache.set(name, { at: Date.now(), entries });
    return entries;
}

async function memoryCorpus() {
    const { cx, names } = memorySources();
    const out = [];
    for (const name of names) {
        let list;
        try {
            list = (await rawEntries(name)).filter(e => !e.disable);
        } catch (err) {
            console.warn('[Хроника]', err);
            continue;
        }
        if (cx) {
            // в чате эпохи — только то, что видно отсюда; не вышло проверить — не показываем ничего
            try { list = await window.SacredTimeline.visible(list, name); } catch (e) { console.warn('[Хроника] фильтр эпохи', e); list = []; }
        }
        const chronicle = !!cx && name === cx.world?.chronicle;
        for (const e of list) {
            const text = cleanText(e.content);
            if (!text) continue;
            const keys = (e.key || []).join(', ');
            const range = (e.STMB_start !== undefined && e.STMB_end !== undefined)
                ? `сообщения #${e.STMB_start}–#${e.STMB_end}` : '';
            out.push({
                book: name, chronicle, title: e.comment || '(без названия)', range,
                text, ntext: norm(`${e.comment || ''}\n${keys}\n${text}`), nbody: norm(text),
            });
        }
    }
    return out;
}

// ───────────── поиск ─────────────

function score(ntext, terms, mode) {
    let hits = 0, occ = 0;
    const matched = [];
    for (const t of terms) {
        const n = countOcc(ntext, t);
        if (n > 0) { hits++; occ += Math.min(n, 10); matched.push(t); }
    }
    if (!hits) return null;
    if (mode === 'all' && hits < terms.length) return null;
    return { s: hits * 100 + occ, matched };
}

async function doSearch(args = {}) {
    const st = settings();
    const terms = parseQuery(args.query);
    if (!terms.length) return 'Пустой запрос. Укажи 1–4 ключевых слова (корни слов) или фразу в кавычках.';

    const mode = args.mode === 'all' ? 'all' : 'any';
    const limit = Math.max(1, Math.min(Number(args.limit) || st.maxResults, 15));
    const chatLen = (ctx().chat || []).length;
    const lastAllowed = chatLen - 1 - Math.max(0, Number(st.skipLast) || 0);
    const from = Number.isFinite(Number(args.from_id)) ? Number(args.from_id) : 0;
    const to = Number.isFinite(Number(args.to_id)) ? Math.min(Number(args.to_id), lastAllowed) : lastAllowed;
    const speaker = args.speaker ? norm(args.speaker) : '';

    const lines = [];
    lines.push(`Запрос: ${terms.join(' | ')} (${mode === 'all' ? 'все слова' : 'любое слово'})`);

    // 1) память STMB / лорбук
    if (args.include_memories !== false) {
        const mem = await memoryCorpus();
        const memHits = [];
        for (const e of mem) {
            const r = score(e.ntext, terms, mode);
            if (r) memHits.push({ e, ...r });
        }
        memHits.sort((a, b) => b.s - a.s);
        if (memHits.length) {
            lines.push('\n=== ПАМЯТЬ (записи лорбука) ===');
            for (const h of memHits.slice(0, 5)) {
                const term = h.matched.find(t => h.e.nbody.includes(t)) || h.matched[0];
                const sn = snippet(h.e.text, h.e.nbody, term, 350) || h.e.text.slice(0, 500) + '…';
                lines.push(`• ${h.e.chronicle ? '[Хроника мира] ' : ''}«${h.e.title}»${h.e.range ? ` [${h.e.range}]` : ''}\n  ${sn}`);
            }
        }
    }

    // 2) сами сообщения
    const corpus = chatCorpus().filter(m => m.id >= from && m.id <= to && (!speaker || norm(m.name).includes(speaker)));
    const hits = [];
    for (const m of corpus) {
        const r = score(m.ntext, terms, mode);
        if (r) hits.push({ m, ...r });
    }
    hits.sort((a, b) => b.s - a.s || b.m.id - a.m.id);

    if (hits.length) {
        lines.push(`\n=== СООБЩЕНИЯ (найдено ${hits.length}, показаны лучшие ${Math.min(limit, hits.length)}) ===`);
        for (const h of hits.slice(0, limit)) {
            const sns = [];
            for (const t of h.matched.slice(0, 2)) {
                const sn = snippet(h.m.text, h.m.ntext, t, 260);
                if (sn && !sns.some(x => x.includes(sn.slice(5, 60)))) sns.push(sn);
            }
            lines.push(`• #${h.m.id} ${h.m.name}:\n  ${sns.join('\n  ')}`);
        }
        lines.push('\nЧтобы прочитать сцену целиком, вызови story_read с номерами сообщений (например, найденное ±2).');
    } else {
        lines.push('\nВ сообщениях ничего не найдено. Попробуй другие корни слов, синонимы или mode="any".');
    }

    let out = lines.join('\n');
    if (out.length > 7000) out = out.slice(0, 7000) + '\n…[обрезано]';
    return out;
}

function doRead(args = {}) {
    const chat = ctx().chat || [];
    let a = Number(args.from_id), b = Number(args.to_id ?? args.from_id);
    if (!Number.isFinite(a)) return 'Укажи from_id (номер сообщения).';
    if (!Number.isFinite(b)) b = a;
    if (b < a) [a, b] = [b, a];
    a = Math.max(0, a);
    b = Math.min(chat.length - 1, b, a + 7);
    const parts = [];
    let total = 0;
    for (let id = a; id <= b; id++) {
        const m = chat[id];
        if (!m || m.extra?.tool_invocations) continue;
        let t = cleanText(m.mes);
        if (t.length > 3500) t = t.slice(0, 3500) + '…[обрезано]';
        const block = `--- #${id} ${m.name || ''} ---\n${t}`;
        if (total + block.length > 14000) { parts.push('…[лимит чтения, запроси меньше сообщений]'); break; }
        parts.push(block);
        total += block.length;
    }
    return parts.length ? parts.join('\n\n') : 'Таких сообщений нет.';
}

// ───────────── регистрация инструментов ─────────────

function registerTools() {
    const c = ctx();
    if (typeof c.registerFunctionTool !== 'function') {
        console.warn('[Хроника] registerFunctionTool недоступен — обнови SillyTavern');
        return;
    }

    c.registerFunctionTool({
        name: TOOL_SEARCH,
        displayName: 'Хроника: поиск',
        description:
            'Search the full earlier history of this roleplay (all messages, including old hidden ones, plus saved memory summaries) ' +
            'for a specific past detail that is NOT in your visible context: what happened on a given day, a promise, an object, ' +
            'a name, who said what, a date. The story is in Russian: query with 1-4 Russian word roots (e.g. "письм вокзал", "кольц обещ"), ' +
            'or an exact phrase in double quotes. Do not search for things that are in the recent messages you can already see. ' +
            'Use at most 2 searches per reply, then continue writing the reply in character. Never mention the search in the story text.',
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Russian keywords or word roots, or a "quoted phrase".' },
                mode: { type: 'string', enum: ['any', 'all'], description: 'any = any word matches (default), all = every word must match.' },
                speaker: { type: 'string', description: 'Optional: only messages by this character name.' },
                from_id: { type: 'integer', description: 'Optional: earliest message number to search.' },
                to_id: { type: 'integer', description: 'Optional: latest message number to search.' },
                limit: { type: 'integer', description: 'Optional: max message hits (default 8, max 15).' },
            },
            required: ['query'],
        },
        action: async (args) => {
            try { return await doSearch(args); }
            catch (e) { console.error('[Хроника]', e); return `Ошибка поиска: ${e.message}`; }
        },
        formatMessage: (args) => `🔎 Хроника ищет: ${args?.query || ''}`,
        shouldRegister: () => !!settings().enabled,
    });

    c.registerFunctionTool({
        name: TOOL_READ,
        displayName: 'Хроника: чтение',
        description:
            'Read the full text of earlier roleplay messages by their numbers (up to 8 in a row), usually right after story_search, ' +
            'to get the exact details and wording of a past scene.',
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                from_id: { type: 'integer', description: 'First message number.' },
                to_id: { type: 'integer', description: 'Last message number (max from_id + 7).' },
            },
            required: ['from_id'],
        },
        action: async (args) => {
            try { return doRead(args); }
            catch (e) { console.error('[Хроника]', e); return `Ошибка чтения: ${e.message}`; }
        },
        formatMessage: (args) => `📖 Хроника читает #${args?.from_id}${args?.to_id !== undefined ? '–#' + args.to_id : ''}`,
        shouldRegister: () => !!settings().enabled,
    });
}

// ───────────── сворачивание результатов после ответа ─────────────

let compacting = false;
async function compactToolResults() {
    if (!settings().compact || compacting) return;
    compacting = true;
    try {
        const chat = ctx().chat || [];
        let changed = false;
        for (let id = 0; id < chat.length; id++) {
            const inv = chat[id]?.extra?.tool_invocations;
            if (!Array.isArray(inv)) continue;
            for (const call of inv) {
                if (!OUR_TOOLS.includes(call?.name) || call._hrCompact) continue;
                const original = String(call.result ?? '');
                const short = `[Хроника: результат ${call.name === TOOL_SEARCH ? 'поиска' : 'чтения'} уже использован в ответе и свёрнут]`;
                call.result = short;
                call._hrCompact = true;
                const m = chat[id];
                if (typeof m.mes === 'string' && original) {
                    const esc = JSON.stringify(original).slice(1, -1);
                    m.mes = m.mes.split(original).join(short).split(esc).join(short);
                }
                changed = true;
            }
        }
        if (changed) await ctx().saveChat();
    } catch (e) {
        console.warn('[Хроника] сворачивание не удалось', e);
    } finally {
        compacting = false;
    }
}

// ───────────── ручная команда /recall ─────────────

function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function registerSlash() {
    const c = ctx();
    try {
        const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = c;
        if (!SlashCommandParser || !SlashCommand) return;
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'recall',
            helpString: 'Хроника: проверить поиск по истории вручную. Пример: /recall письм вокзал',
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({ description: 'запрос', typeList: [ARGUMENT_TYPE.STRING], isRequired: true }),
            ],
            callback: async (_args, value) => {
                const res = await doSearch({ query: String(value || '') });
                const html = `<div class="hr-popup">${escapeHtml(res)}</div>`;
                if (typeof c.callGenericPopup === 'function') {
                    await c.callGenericPopup(html, c.POPUP_TYPE?.TEXT ?? 1, '', { wide: true, allowVerticalScrolling: true });
                } else {
                    alert(res);
                }
                return '';
            },
        }));
    } catch (e) {
        console.warn('[Хроника] /recall не зарегистрирован', e);
    }
}

// ───────────── настройки ─────────────

function renderSettings() {
    const st = settings();
    const c = ctx();
    const toolsOk = typeof c.isToolCallingSupported === 'function' ? c.isToolCallingSupported() : null;
    const html = `
    <div id="chronika_settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>Хроника — поиск по истории</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <div id="hr_warn" class="hr-warn" style="display:${toolsOk === false ? 'block' : 'none'}">
            Сейчас вызов инструментов выключен или не поддерживается текущим подключением. Включи «Enable function calling» в настройках пресета.
          </div>
          <label class="checkbox_label"><input id="hr_enabled" type="checkbox" ${st.enabled ? 'checked' : ''}> Включено</label>
          <label class="checkbox_label"><input id="hr_compact" type="checkbox" ${st.compact ? 'checked' : ''}> Сворачивать результаты после ответа</label>
          <div class="hr-row">
            <label for="hr_books">Лорбуки с памятью (через запятую) — для чатов вне эпох</label>
            <input id="hr_books" class="text_pole" type="text" value="${escapeHtml(st.lorebooks)}">
          </div>
          <div id="hr_era" class="hr-hint"></div>
          <div class="hr-row">
            <label for="hr_skip">Не искать в последних N сообщениях (они и так в контексте)</label>
            <input id="hr_skip" class="text_pole" type="number" min="0" max="500" value="${st.skipLast}">
          </div>
          <div class="hr-row">
            <label for="hr_max">Сколько сообщений показывать модели</label>
            <input id="hr_max" class="text_pole" type="number" min="1" max="15" value="${st.maxResults}">
          </div>
          <div class="hr-row">
            <label for="hr_tags">Вырезать блоки тегов (через запятую)</label>
            <input id="hr_tags" class="text_pole" type="text" value="${escapeHtml(st.stripTags)}">
          </div>
          <div class="hr-hint">Проверка вручную: напиши в чат <code>/recall письм вокзал</code> — откроется окно с тем, что увидит модель.</div>
        </div>
      </div>
    </div>`;
    $('#extensions_settings2').append(html);

    const save = () => c.saveSettingsDebounced();
    $('#hr_enabled').on('change', function () { st.enabled = this.checked; save(); });
    $('#hr_compact').on('change', function () { st.compact = this.checked; save(); });
    $('#hr_books').on('input', function () { st.lorebooks = this.value; bookCache.clear(); save(); });
    $('#hr_skip').on('input', function () { st.skipLast = Math.max(0, parseInt(this.value) || 0); save(); });
    $('#hr_max').on('input', function () { st.maxResults = Math.max(1, Math.min(15, parseInt(this.value) || 8)); save(); });
    $('#hr_tags').on('input', function () { st.stripTags = this.value; save(); });
}

/** Строка в настройках: откуда сейчас берётся память. */
function renderEra() {
    const el = document.getElementById('hr_era');
    if (!el) return;
    const { cx, names } = memorySources();
    if (!cx) {
        el.textContent = '';
        return;
    }
    const mem = cx.era?.memoryBook;
    const when = cx.date ? ` на ${cx.date}` : '';
    el.textContent = `Эпоха ${cx.era.id}: память — ${mem ? `«${mem}»` : 'меморибука у эпохи нет'}`
        + `${cx.world?.chronicle ? `, плюс Хроника мира — только то, что видно${when}` : ''}. Будущего поиск отсюда не видит.`
        + (names.length ? '' : ' Искать в памяти пока негде — только в сообщениях чата.');
}

// ───────────── старт ─────────────

jQuery(async () => {
    settings();
    renderSettings();
    registerTools();
    registerSlash();

    const { eventSource, eventTypes } = ctx();
    const done = eventTypes?.GENERATION_ENDED || 'generation_ended';
    eventSource.on(done, () => setTimeout(compactToolResults, 800));
    eventSource.on(eventTypes?.CHAT_CHANGED || 'chat_id_changed', () => { bookCache.clear(); renderEra(); });
    eventSource.on('sacred-timeline:changed', () => renderEra());
    renderEra();
    console.log('[Хроника] загружена');
});
