// «Así quedaría» — lógica de la página.

/* ================================================================== */
/* Utilidades                                                          */
/* ================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c.nodeType ? c : document.createTextNode(String(c)));
  return node;
}

function svgIcon(path) {
  const span = document.createElement('span');
  span.innerHTML = `<svg viewBox="0 0 24 24" class="icon" aria-hidden="true">${path}</svg>`;
  return span.firstChild;
}
const ICON_X = '<path d="M6 6l12 12M18 6L6 18"/>';
const ICON_TRASH = '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>';
const ICON_PLUS = '<path d="M12 5v14M5 12h14"/>';

let toastTimer;
function toast(message, type = 'info', ms = 4200) {
  const t = $('#toast');
  t.textContent = message;
  t.className = `toast ${type}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), type === 'error' ? Math.max(ms, 7000) : ms);
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function parseMeasure(v) {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}
const hasMeasures = (it) => Boolean(parseMeasure(it.width) || parseMeasure(it.depth) || parseMeasure(it.height));
const itemName = (it, i) => (it.name || '').trim() || `objeto ${i + 1}`;

function formatTime(ts) {
  return new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(ts);
}

/* ================================================================== */
/* Imágenes                                                            */
/* ================================================================== */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('No se pudo leer la imagen.'));
    img.src = src;
  });
}

/** Lee un archivo, lo reduce y lo devuelve como JPEG en data URL. */
async function processFile(file, maxSide) {
  if (!file.type.startsWith('image/') && !/\.(heic|heif|jpe?g|png|webp)$/i.test(file.name)) {
    throw new Error(`«${file.name}» no es una imagen.`);
  }
  const url = URL.createObjectURL(file);
  try {
    let img;
    try {
      img = await loadImage(url);
    } catch {
      throw new Error(`No se pudo abrir «${file.name}». Si es HEIC, expórtala como JPEG.`);
    }
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const src = drawToDataUrl(img, w, h, 0.88);
    const ts = Math.min(1, 280 / Math.max(w, h));
    const thumb = drawToDataUrl(img, Math.round(w * ts), Math.round(h * ts), 0.8);
    return { id: uid(), src, thumb, w, h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawToDataUrl(img, w, h, quality) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; // fondo para PNG con transparencia
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/jpeg', quality);
}

/* ================================================================== */
/* Almacenamiento local (IndexedDB)                                    */
/* ================================================================== */

const db = (() => {
  let dbp = null;
  const open = () => {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open('asi-quedaria', 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore('kv');
          req.result.createObjectStore('versions', { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  };
  const tx = async (store, mode, fn) => {
    const d = await open();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const r = fn(t.objectStore(store));
      t.oncomplete = () => resolve(r?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  };
  return {
    get: (k) => tx('kv', 'readonly', (s) => s.get(k)),
    set: (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k)),
    allVersions: () => tx('versions', 'readonly', (s) => s.getAll()),
    putVersion: (v) => tx('versions', 'readwrite', (s) => s.put(v)),
    deleteVersion: (id) => tx('versions', 'readwrite', (s) => s.delete(id)),
    clear: async () => {
      await tx('kv', 'readwrite', (s) => s.clear());
      await tx('versions', 'readwrite', (s) => s.clear());
    },
  };
})();

let storageOk = true;
async function safe(p, fallback) {
  try {
    return await p;
  } catch (e) {
    if (storageOk) {
      storageOk = false;
      console.warn(e);
      toast('No se pudo guardar en este navegador (¿modo privado o sin espacio?). Descarga las imágenes que quieras conservar.', 'error');
    }
    return fallback;
  }
}

/* ================================================================== */
/* Estado                                                              */
/* ================================================================== */

const emptyProject = () => ({ room: { main: null, angles: [] }, items: [], inspo: [], instructions: '', roomSize: '' });

const state = {
  project: emptyProject(),
  versions: [],
  currentId: null,
  service: { configured: false, loaded: false, maxImages: 14 },
  busy: false,
  view: 'before-after',
  compare: { left: 'original', right: null },
  dialog: { itemId: null, action: 'move' },
};

const saveProject = debounce(() => safe(db.set('project', state.project)), 400);
const currentVersion = () => state.versions.find((v) => v.id === state.currentId) || null;

const EXAMPLE =
  'Coloca mi sofá beige frente a la ventana, mueve la mesa de madera al centro, conserva el piso y prueba cortinas blancas. De la segunda referencia, toma solo los tonos verdes y la iluminación cálida.';
const INSPO_CHIPS = ['Solo la paleta', 'La iluminación', 'Cómo están puestos los cuadros', 'Los materiales', 'La distribución', 'Las plantas'];
const STATUS = [
  { id: 'usar', label: 'Usar' },
  { id: 'variante', label: 'Probar en una variante' },
  { id: 'fuera', label: 'Dejar fuera' },
];

/* ================================================================== */
/* Carga de fotos                                                      */
/* ================================================================== */

const SIZES = { 'room-main': 1600, angles: 1024, items: 1024, inspo: 1024 };

async function addFiles(kind, fileList) {
  const files = [...fileList].filter(Boolean);
  if (!files.length) return;
  const p = state.project;
  const list = kind === 'room-main' ? files.slice(0, 1) : files;
  let added = 0;
  for (const file of list) {
    try {
      const img = await processFile(file, SIZES[kind]);
      if (kind === 'room-main') {
        // Si ya había una foto principal, pasa a ser un ángulo adicional.
        if (p.room.main) p.room.angles.unshift(p.room.main);
        p.room.main = img;
        // Si se subieron varias a la vez, el resto son ángulos.
        for (const extra of files.slice(1)) {
          try { p.room.angles.push(await processFile(extra, SIZES.angles)); } catch (e) { toast(e.message, 'error'); }
        }
      } else if (kind === 'angles') p.room.angles.push(img);
      else if (kind === 'items') p.items.push({ ...img, name: '', status: 'usar', width: '', depth: '', height: '' });
      else if (kind === 'inspo') p.inspo.push({ ...img, note: '' });
      added++;
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  if (!added) return;
  saveProject();
  if (kind === 'room-main' || kind === 'angles') renderRoom();
  if (kind === 'items') {
    renderItems();
    const inputs = $$('#items-list .obj-name');
    inputs[inputs.length - added]?.focus();
  }
  if (kind === 'inspo') {
    renderInspo();
    const inputs = $$('#inspo-list .note-input');
    inputs[inputs.length - added]?.focus();
  }
  renderChips();
  renderGenerateState();
}

function bindUploads() {
  document.addEventListener('change', (e) => {
    const input = e.target.closest('input[type=file][data-input]');
    if (!input) return;
    addFiles(input.dataset.input, input.files).finally(() => (input.value = ''));
  });

  // Arrastrar y soltar (escritorio)
  for (const zone of $$('[data-drop]')) {
    zone.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', (e) => {
      if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over');
    });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      addFiles(zone.dataset.drop, e.dataTransfer.files);
    });
  }
  // Evita que el navegador abra la imagen si se suelta fuera de una zona.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}

/* ================================================================== */
/* Render del panel                                                    */
/* ================================================================== */

function renderRoom() {
  const { main, angles } = state.project.room;
  const box = $('#room-main');
  box.classList.toggle('has-photo', Boolean(main));
  const empty = box.querySelector('.room-empty');
  $$('.main-img, .room-photo-actions, .badge', box).forEach((n) => n.remove());
  empty.hidden = Boolean(main);
  if (main) {
    box.append(
      el('span', { class: 'badge' }, 'Foto principal · base'),
      el('img', { class: 'main-img', src: main.src, alt: 'Foto principal de la habitación' }),
      el('div', { class: 'room-photo-actions' },
        el('label', { class: 'btn-soft small', style: 'background:rgba(251,248,242,.94)' }, 'Cambiar',
          el('input', { type: 'file', accept: 'image/*', hidden: true, dataset: { input: 'room-main' } })),
        el('button', {
          class: 'icon-btn', type: 'button', 'aria-label': 'Quitar foto principal',
          onclick: () => {
            const p = state.project;
            p.room.main = p.room.angles.shift() || null; // el primer ángulo pasa a ser la principal
            saveProject(); renderRoom(); renderGenerateState();
          },
        }, svgIcon(ICON_TRASH)),
      ),
    );
  }

  const grid = $('#room-angles');
  grid.replaceChildren(
    ...angles.map((a, i) =>
      el('div', { class: 'thumb' },
        el('img', { src: a.thumb, alt: `Ángulo ${i + 1}` }),
        el('button', {
          class: 'icon-btn', type: 'button', 'aria-label': `Quitar ángulo ${i + 1}`,
          onclick: () => { angles.splice(i, 1); saveProject(); renderRoom(); renderGenerateState(); },
        }, svgIcon(ICON_X)),
      ),
    ),
    el('label', { class: 'thumb-add' },
      el('span', {}, svgIcon(ICON_PLUS), el('br'), 'Agregar ángulo'),
      el('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, dataset: { input: 'angles' } })),
  );

  const preview = $('#empty-preview');
  preview.hidden = !main;
  if (main) preview.src = main.src;
}

function measuresLabel(it) {
  const parts = [it.width, it.depth, it.height].map(parseMeasure);
  if (!parts.some(Boolean)) return 'Agregar medidas (opcional)';
  return parts.map((n) => (n ? String(n).replace('.', ',') : '–')).join(' × ') + ' cm';
}

function renderItems() {
  const list = $('#items-list');
  list.dataset.empty = 'Sube fotos de tus muebles: tu sofá, la mesa, la lámpara…';
  list.replaceChildren(
    ...state.project.items.map((it, i) => {
      const card = el('div', { class: `obj-card${it.status === 'fuera' ? ' is-out' : ''}` });
      const summary = el('summary', {}, el('span', { class: hasMeasures(it) ? 'has-measures' : '' }, measuresLabel(it)));
      const measure = (key, label) =>
        el('label', {}, label,
          el('input', {
            type: 'text', inputmode: 'decimal', value: it[key] || '', placeholder: 'cm',
            oninput: (e) => {
              it[key] = e.target.value.trim();
              summary.firstChild.textContent = measuresLabel(it);
              summary.firstChild.className = hasMeasures(it) ? 'has-measures' : '';
              saveProject();
            },
          }));
      const seg = el('div', { class: 'status-seg', role: 'group', 'aria-label': 'Uso en la propuesta' },
        ...STATUS.map((s) =>
          el('button', {
            type: 'button', 'aria-pressed': String(it.status === s.id), dataset: { status: s.id },
            onclick: () => {
              it.status = s.id;
              $$('button', seg).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.status === s.id)));
              card.classList.toggle('is-out', s.id === 'fuera');
              saveProject(); renderChips(); renderGenerateState();
            },
          }, s.label)));
      card.append(
        el('div', { class: 'obj-thumb' }, el('img', { src: it.thumb, alt: '' })),
        el('div', { class: 'obj-body' },
          el('div', { class: 'obj-top' },
            el('input', {
              class: 'obj-name', type: 'text', value: it.name, placeholder: `Ponle nombre, p. ej. «mi sofá»`,
              'aria-label': `Nombre del objeto ${i + 1}`, autocomplete: 'off', enterkeyhint: 'done',
              oninput: (e) => { it.name = e.target.value; saveProject(); renderChips(); renderGenerateState(); },
              onkeydown: (e) => e.key === 'Enter' && e.target.blur(),
            }),
            el('button', {
              class: 'icon-btn plain', type: 'button', 'aria-label': `Quitar ${itemName(it, i)}`,
              onclick: () => {
                state.project.items.splice(i, 1);
                saveProject(); renderItems(); renderChips(); renderGenerateState();
              },
            }, svgIcon(ICON_TRASH)),
          ),
          seg,
          el('details', { class: 'measures' },
            summary,
            el('div', { class: 'measure-grid' }, measure('width', 'Ancho'), measure('depth', 'Fondo'), measure('height', 'Alto')),
          ),
        ),
      );
      return card;
    }),
  );
}

function renderInspo() {
  const list = $('#inspo-list');
  list.dataset.empty = 'Sube fotos que te inspiren: revistas, Pinterest, hoteles…';
  list.replaceChildren(
    ...state.project.inspo.map((ins, i) => {
      const input = el('input', {
        class: 'note-input', type: 'text', value: ins.note, autocomplete: 'off', enterkeyhint: 'done',
        placeholder: '¿Qué te gusta de esta? p. ej. «solo la paleta»',
        'aria-label': `Qué te gusta de la referencia ${i + 1}`,
        oninput: (e) => { ins.note = e.target.value; syncChips(); saveProject(); },
        onkeydown: (e) => e.key === 'Enter' && e.target.blur(),
      });
      const chips = el('div', { class: 'chips' },
        ...INSPO_CHIPS.map((c) =>
          el('button', {
            type: 'button', class: 'chip', dataset: { chip: c },
            onclick: () => {
              const has = ins.note.toLowerCase().includes(c.toLowerCase());
              if (has) {
                ins.note = ins.note.replace(new RegExp(`(,\\s*)?${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'), '').replace(/^,\s*/, '').trim();
              } else {
                ins.note = ins.note.trim() ? `${ins.note.trim()}, ${c.toLowerCase()}` : c;
              }
              input.value = ins.note;
              syncChips(); saveProject();
            },
          }, c)));
      function syncChips() {
        $$('.chip', chips).forEach((b) =>
          b.setAttribute('aria-pressed', String(ins.note.toLowerCase().includes(b.dataset.chip.toLowerCase()))));
      }
      syncChips();
      return el('div', { class: 'obj-card' },
        el('div', { class: 'obj-thumb' }, el('img', { src: ins.thumb, alt: '' })),
        el('div', { class: 'obj-body' },
          el('div', { class: 'obj-top' },
            el('span', { class: 'inspo-num', style: 'flex:1' }, `Referencia ${i + 1}`),
            el('button', {
              class: 'icon-btn plain', type: 'button', 'aria-label': `Quitar referencia ${i + 1}`,
              onclick: () => { state.project.inspo.splice(i, 1); saveProject(); renderInspo(); renderChips(); renderGenerateState(); },
            }, svgIcon(ICON_TRASH)),
          ),
          input,
          chips,
        ),
      );
    }),
  );
}

/** Atajos para insertar nombres de objetos y referencias en las instrucciones. */
function renderChips() {
  const chips = [];
  state.project.items.forEach((it, i) => {
    if (it.status !== 'fuera' && it.name.trim()) chips.push(it.name.trim());
  });
  state.project.inspo.forEach((_, i) => chips.push(`referencia ${i + 1}`));
  $('#name-chips').replaceChildren(
    ...chips.map((name) =>
      el('button', { type: 'button', class: 'chip', title: 'Insertar en el texto', onclick: () => insertAtCursor($('#instructions'), name) }, `+ ${name}`)),
  );
}

function insertAtCursor(ta, text) {
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  const before = ta.value.slice(0, start);
  const pad = before && !/\s$/.test(before) ? ' ' : '';
  ta.setRangeText(pad + text + ' ', start, end, 'end');
  ta.focus();
  ta.dispatchEvent(new Event('input'));
}

/* ================================================================== */
/* Estado del botón de generación                                      */
/* ================================================================== */

function generationJobs() {
  const p = state.project;
  const usar = p.items.filter((i) => i.status === 'usar');
  const variante = p.items.filter((i) => i.status === 'variante');
  const jobs = [{ kind: 'propuesta', items: usar, exclude: p.items.filter((i) => i.status !== 'usar') }];
  if (variante.length) jobs.push({ kind: 'variante', items: [...usar, ...variante], exclude: p.items.filter((i) => i.status === 'fuera') });
  return jobs;
}

function imageCountFor(job) {
  const p = state.project;
  return 1 + p.room.angles.length + job.items.length + p.inspo.length;
}

function renderGenerateState() {
  const btn = $('#btn-generate');
  const hint = $('#generate-hint');
  const p = state.project;
  const jobs = generationJobs();
  const maxCount = Math.max(...jobs.map(imageCountFor));
  let reason = '';
  if (!state.service.loaded) reason = 'Comprobando el servicio de imágenes…';
  else if (!state.service.configured) reason = 'El servicio de imágenes no está conectado. Revisa el aviso de arriba.';
  else if (!p.room.main) reason = 'Sube la foto principal de tu habitación para empezar.';
  else if (!p.instructions.trim() && !jobs[0].items.length && jobs.length < 2) reason = 'Agrega al menos un mueble marcado como «Usar» o escribe cómo quieres que quede.';
  else if (maxCount > state.service.maxImages) reason = `Hay ${maxCount} fotos para enviar y el modelo admite ${state.service.maxImages}. Marca algunos objetos como «Dejar fuera» o quita referencias.`;
  btn.disabled = Boolean(reason) || state.busy;

  if (state.busy) hint.textContent = 'Generando… puedes seguir editando mientras tanto.';
  else if (reason) hint.textContent = reason;
  else {
    const unnamed = p.items.filter((i) => i.status !== 'fuera' && !i.name.trim()).length;
    const parts = [];
    if (jobs.length > 1) parts.push('Se crearán 2 versiones: la propuesta y una variante con los objetos a probar.');
    if (unnamed) parts.push(`Consejo: ponle nombre a ${unnamed === 1 ? 'un objeto' : `${unnamed} objetos`} para poder mencionarlos.`);
    hint.textContent = parts.join(' ');
  }
  $('#btn-refine').disabled = state.busy || !state.service.configured;
  $('#dlg-apply').disabled = state.busy || !state.service.configured;
}

/* ================================================================== */
/* Servicio de imágenes                                                */
/* ================================================================== */

async function loadServiceStatus() {
  const pill = $('#service-pill');
  const banner = $('#service-banner');
  try {
    const res = await fetch('api/status', { cache: 'no-store' });
    if (!res.ok) throw new Error();
    const s = await res.json();
    state.service = { ...s, loaded: true };
    if (s.demo) {
      pill.dataset.state = 'demo';
      pill.textContent = 'Modo de prueba';
      banner.className = 'banner demo';
      banner.innerHTML = '<div><strong>Modo de prueba activo.</strong> El servidor devuelve la foto sin editar para probar la interfaz. Configura <code>GEMINI_API_KEY</code> u <code>OPENAI_API_KEY</code> para generar propuestas reales.</div>';
      banner.hidden = false;
    } else if (s.configured) {
      pill.dataset.state = 'ok';
      pill.textContent = 'IA conectada';
      pill.title = `${s.providerLabel} · ${s.model}`;
      banner.hidden = true;
    } else {
      pill.dataset.state = 'off';
      pill.textContent = 'IA sin conectar';
      banner.className = 'banner';
      banner.innerHTML = `<div><strong>El servicio de imágenes no está conectado.</strong> Puedes subir tus fotos y preparar las instrucciones, pero el botón «Ver cómo quedaría» seguirá desactivado hasta conectarlo. Agrega <code>${s.missing || 'GEMINI_API_KEY'}</code> al archivo <code>.env</code> del servidor y reinícialo.</div>`;
      banner.hidden = false;
    }
  } catch {
    state.service = { configured: false, loaded: true, maxImages: 14 };
    pill.dataset.state = 'off';
    pill.textContent = 'Sin servidor';
    banner.className = 'banner';
    banner.innerHTML = '<div><strong>No se encontró el servidor de «Así quedaría».</strong> Abre la página con <code>npm start</code> (no directamente como archivo) para poder generar propuestas.</div>';
    banner.hidden = false;
  }
  renderGenerateState();
}

async function callGenerate(payload) {
  let res;
  try {
    res = await fetch('api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error('No se pudo conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.image) throw new Error(data.error || `Error ${res.status} al generar la imagen.`);
  return data;
}

/* ================================================================== */
/* Generación y ajustes                                                */
/* ================================================================== */

const LOADING_STEPS = ['Analizando tu habitación…', 'Colocando tus muebles…', 'Ajustando perspectiva y proporciones…', 'Integrando luces y sombras…', 'Últimos detalles…'];
let loadingTimer;

function setBusy(busy, label) {
  state.busy = busy;
  const overlay = $('#stage-loading');
  clearInterval(loadingTimer);
  if (busy) {
    $('#stage-empty').hidden = true;
    $('#stage-result').hidden = false;
    if (!currentVersion()) {
      // Aún no hay propuestas: muestra la foto original mientras se genera.
      const main = state.project.room.main;
      setSlider(main.src, main.src, { single: true, ratio: main.w / main.h });
      $('#tag-right').textContent = 'Tu habitación';
      $('#result-title').textContent = 'Tu primera propuesta';
      $('#result-eyebrow').textContent = 'Generando';
    }
    let i = 0;
    $('#loading-text').textContent = label || LOADING_STEPS[0];
    if (!label) loadingTimer = setInterval(() => ($('#loading-text').textContent = LOADING_STEPS[Math.min(++i, LOADING_STEPS.length - 1)]), 9000);
    overlay.hidden = false;
  } else {
    overlay.hidden = true;
  }
  renderGenerateState();
}

function itemPayload(it, name) {
  return { name, image: it.src, width: it.width, depth: it.depth, height: it.height };
}

function snapshotItem(it, name) {
  return { id: it.id, name, thumb: it.thumb, width: it.width, depth: it.depth, height: it.height };
}

async function generate() {
  const p = state.project;
  if (!p.room.main || state.busy) return;
  const jobs = generationJobs();
  const names = new Map(p.items.map((it, i) => [it.id, itemName(it, i)]));
  const room = p.room.main;

  setBusy(true, jobs.length > 1 ? 'Generando la propuesta y una variante…' : null);
  if (matchMedia('(max-width: 999px)').matches) $('#stage').scrollIntoView({ behavior: 'smooth', block: 'start' });

  const results = await Promise.allSettled(
    jobs.map((job) =>
      callGenerate({
        mode: 'create',
        base: room.src,
        aspect: room.w / room.h,
        angles: p.room.angles.map((a) => a.src),
        items: job.items.map((it) => itemPayload(it, names.get(it.id))),
        exclude: job.exclude.map((it) => names.get(it.id)),
        inspirations: p.inspo.map((ins) => ({ image: ins.src, note: ins.note })),
        instructions: p.instructions,
        roomSize: p.roomSize,
      }).then((data) => ({ job, data })),
    ),
  );

  const created = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const { job, data } = r.value;
    created.push(
      await addVersion({
        kind: job.kind,
        image: data.image,
        before: room.src,
        items: job.items.map((it) => snapshotItem(it, names.get(it.id))),
        instruction: p.instructions,
        parentId: null,
      }),
    );
  }
  setBusy(false);
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) toast(failed[0].reason.message, 'error');
  if (created.length) {
    selectVersion(created[0].id);
    if (created.length > 1) toast('Listo: se guardaron la propuesta y la variante. Puedes compararlas abajo.');
  } else if (!currentVersion()) {
    renderStage();
  }
}

async function refine(instruction, { removeId = null } = {}) {
  const base = currentVersion();
  if (!base || state.busy) return;
  const text = instruction.trim();
  if (!text) { toast('Escribe qué quieres ajustar.'); return; }
  const live = new Map(state.project.items.map((it) => [it.id, it]));
  setBusy(true, 'Aplicando tu ajuste…');
  try {
    const data = await callGenerate({
      mode: 'refine',
      base: base.image,
      aspect: base.ratio,
      refine: text,
      items: base.items.map((s) => {
        const it = live.get(s.id);
        return { name: s.name, image: it ? it.src : s.thumb, width: s.width, depth: s.depth, height: s.height };
      }),
    });
    const v = await addVersion({
      kind: 'ajuste',
      image: data.image,
      before: base.before,
      items: base.items.filter((s) => s.id !== removeId),
      instruction: text,
      parentId: base.id,
    });
    setBusy(false);
    $('#refine-input').value = '';
    selectVersion(v.id);
  } catch (e) {
    setBusy(false);
    toast(e.message, 'error');
  }
}

async function addVersion({ kind, image, before, items, instruction, parentId }) {
  let ratio = 4 / 3;
  try {
    const img = await loadImage(image);
    ratio = img.naturalWidth / img.naturalHeight;
  } catch { /* se mantiene la proporción por defecto */ }
  const seq = (state.versions.reduce((m, v) => Math.max(m, v.seq || 0), 0) || 0) + 1;
  const kindLabel = { propuesta: 'Propuesta', variante: 'Variante', ajuste: 'Ajuste' }[kind];
  const parent = state.versions.find((v) => v.id === parentId);
  const v = {
    id: uid(),
    seq,
    name: kind === 'ajuste' && parent ? `${parent.name} · ajuste` : `${kindLabel} ${seq}`,
    kind,
    createdAt: Date.now(),
    image,
    before,
    ratio,
    items,
    missing: items.filter((s) => !hasMeasures(s)).map((s) => s.name),
    instruction,
    parentId,
  };
  state.versions.push(v);
  await safe(db.putVersion(v));
  return v;
}

/* ================================================================== */
/* Escenario de resultados                                             */
/* ================================================================== */

function selectVersion(id) {
  state.currentId = id;
  state.compare.right = id;
  if (state.compare.left === id) state.compare.left = 'original';
  safe(db.set('currentId', id));
  renderStage();
}

function renderStage() {
  const v = currentVersion();
  $('#stage-empty').hidden = Boolean(v) || state.busy;
  $('#stage-result').hidden = !v && !state.busy;
  if (!v) return;

  $('#result-eyebrow').textContent = `${{ propuesta: 'Propuesta', variante: 'Variante', ajuste: 'Ajuste' }[v.kind]} · ${formatTime(v.createdAt)}`;
  const title = $('#result-title');
  if (document.activeElement !== title) title.textContent = v.name;

  const note = $('#scale-note');
  note.hidden = !v.missing.length;
  if (v.missing.length) {
    const list = v.missing.map((n) => `«${n}»`);
    const joined = list.length > 1 ? `${list.slice(0, -1).join(', ')} y ${list.at(-1)}` : list[0];
    note.textContent = `Escala aproximada: no indicaste medidas de ${joined}. Agrégalas en «Mis muebles y objetos» para una proporción más fiel.`;
  }

  renderSlider();
  renderIncluded(v);
  renderVersions();
}

function versionLabel(id) {
  if (id === 'original') return 'Foto original';
  return state.versions.find((v) => v.id === id)?.name || '';
}

function renderSlider() {
  const v = currentVersion();
  if (!v) return;
  const isCompare = state.view === 'compare';
  $('#compare-pickers').hidden = !isCompare;
  $$('.seg [data-view]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === state.view)));

  if (!isCompare) {
    setSlider(v.before, v.image, { ratio: v.ratio });
    $('#tag-left').textContent = 'Antes';
    $('#tag-right').textContent = 'Después';
    return;
  }
  const opts = [{ id: 'original', name: 'Foto original' }, ...[...state.versions].reverse()];
  for (const [sel, key] of [[$('#cmp-left'), 'left'], [$('#cmp-right'), 'right']]) {
    if (!opts.some((o) => o.id === state.compare[key])) state.compare[key] = key === 'left' ? 'original' : v.id;
    sel.replaceChildren(...opts.map((o) => el('option', { value: o.id, selected: o.id === state.compare[key] }, o.name)));
  }
  const src = (id) => (id === 'original' ? v.before : state.versions.find((x) => x.id === id).image);
  setSlider(src(state.compare.left), src(state.compare.right), { ratio: v.ratio });
  $('#tag-left').textContent = versionLabel(state.compare.left);
  $('#tag-right').textContent = versionLabel(state.compare.right);
}

function setSlider(beforeSrc, afterSrc, { single = false, ratio } = {}) {
  const slider = $('#slider');
  slider.classList.toggle('single', single);
  if (ratio) slider.style.setProperty('--ratio', String(ratio));
  const b = $('#slider-before');
  const a = $('#slider-after');
  if (b.getAttribute('src') !== beforeSrc) b.src = beforeSrc;
  if (a.getAttribute('src') !== afterSrc) a.src = afterSrc;
}

function bindSlider() {
  const slider = $('#slider');
  const range = $('#slider-range');
  let dragging = false;
  const setPos = (pct) => {
    pct = Math.max(0, Math.min(100, pct));
    slider.style.setProperty('--pos', `${pct}%`);
    range.value = String(Math.round(pct));
  };
  const fromEvent = (e) => {
    const r = slider.getBoundingClientRect();
    setPos(((e.clientX - r.left) / r.width) * 100);
  };
  slider.addEventListener('pointerdown', (e) => {
    if (slider.classList.contains('single') || !$('#stage-loading').hidden) return;
    dragging = true;
    slider.setPointerCapture(e.pointerId);
    fromEvent(e);
    range.focus({ preventScroll: true });
  });
  slider.addEventListener('pointermove', (e) => dragging && fromEvent(e));
  const stop = () => (dragging = false);
  slider.addEventListener('pointerup', stop);
  slider.addEventListener('pointercancel', stop);
  range.addEventListener('input', () => setPos(Number(range.value)));
}

function renderIncluded(v) {
  $('#included-row').replaceChildren(
    ...v.items.map((s) =>
      el('button', { type: 'button', class: 'inc-card', onclick: () => openItemDialog(s) },
        el('img', { src: s.thumb, alt: '' }),
        el('span', {}, s.name),
        el('small', {}, hasMeasures(s) ? measuresLabel(s) : 'Escala aproximada'),
      )),
  );
}

function renderVersions() {
  const sorted = [...state.versions].sort((a, b) => b.createdAt - a.createdAt);
  $('#versions-count').textContent = `${sorted.length} ${sorted.length === 1 ? 'versión guardada' : 'versiones guardadas'} en este navegador`;
  $('#versions-row').replaceChildren(
    ...sorted.map((v) =>
      el('div', {
        class: 'ver-card', role: 'button', tabindex: '0', 'aria-current': String(v.id === state.currentId),
        'aria-label': `Ver ${v.name}`,
        onclick: () => selectVersion(v.id),
        onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), selectVersion(v.id)),
      },
        el('img', { src: v.image, alt: '', loading: 'lazy' }),
        el('span', { class: `ver-tag ${v.kind}` }, { propuesta: 'Propuesta', variante: 'Variante', ajuste: 'Ajuste' }[v.kind]),
        el('span', { class: 'ver-name' }, v.name),
        el('span', { class: 'ver-meta' }, formatTime(v.createdAt)),
        el('button', {
          class: 'icon-btn ver-del', type: 'button', 'aria-label': `Eliminar ${v.name}`,
          onclick: (e) => { e.stopPropagation(); deleteVersion(v.id); },
        }, svgIcon(ICON_TRASH)),
      )),
  );
}

async function deleteVersion(id) {
  const v = state.versions.find((x) => x.id === id);
  if (!v || !confirm(`¿Eliminar «${v.name}»? Esta acción no se puede deshacer.`)) return;
  state.versions = state.versions.filter((x) => x.id !== id);
  await safe(db.deleteVersion(id));
  if (state.compare.left === id) state.compare.left = 'original';
  if (state.currentId === id) {
    const latest = [...state.versions].sort((a, b) => b.createdAt - a.createdAt)[0];
    state.currentId = latest?.id || null;
    state.compare.right = state.currentId;
  }
  renderStage();
}

async function downloadCurrent() {
  const v = currentVersion();
  if (!v) return;
  const blob = await (await fetch(v.image)).blob();
  const ext = blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : 'jpg';
  const slug = v.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `asi-quedaria-${slug || 'propuesta'}.${ext}` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/* ================================================================== */
/* Diálogo de objeto                                                   */
/* ================================================================== */

const DIALOG_ACTIONS = {
  move: { label: '¿A dónde lo movemos?', placeholder: 'p. ej. junto a la ventana, contra la pared izquierda', help: 'Se moverá solo este objeto; el resto queda igual.', needsText: true },
  remove: { label: '', placeholder: '', help: 'Se quitará de la escena y se reconstruirá lo que había detrás.', needsText: false },
  change: { label: '¿Qué quieres cambiar?', placeholder: 'p. ej. hazlo un poco más pequeño, gíralo hacia el sofá', help: 'Describe el cambio; se mantendrá todo lo demás.', needsText: true },
};

function openItemDialog(snapshot) {
  state.dialog = { itemId: snapshot.id, action: 'move', snapshot };
  $('#dlg-img').src = snapshot.thumb;
  $('#dlg-name').textContent = snapshot.name;
  $('#dlg-input').value = '';
  setDialogAction('move');
  $('#item-dialog').showModal();
  setTimeout(() => $('#dlg-input').focus(), 50);
}

function setDialogAction(action) {
  state.dialog.action = action;
  const cfg = DIALOG_ACTIONS[action];
  $$('#dlg-actions button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.action === action)));
  $('#dlg-field').hidden = !cfg.needsText;
  $('#dlg-label').textContent = cfg.label;
  $('#dlg-input').placeholder = cfg.placeholder;
  $('#dlg-help').textContent = cfg.help;
  $('#dlg-apply').textContent = action === 'remove' ? 'Quitar de la escena' : 'Aplicar';
}

function bindDialog() {
  const dlg = $('#item-dialog');
  $$('#dlg-actions button').forEach((b) => b.addEventListener('click', () => setDialogAction(b.dataset.action)));
  $('#dlg-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#dlg-apply').click(); }
  });
  $('#item-dialog-form').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'apply') return; // cerrar / cancelar
    const { action, snapshot } = state.dialog;
    const text = $('#dlg-input').value.trim();
    if (DIALOG_ACTIONS[action].needsText && !text) {
      e.preventDefault();
      $('#dlg-input').focus();
      return;
    }
    const name = `«${snapshot.name}»`;
    const instruction = {
      move: `Mueve ${name} ${text}. Conserva su forma, color y material, y deja todo lo demás exactamente igual.`,
      remove: `Quita ${name} de la escena por completo y reconstruye de forma natural lo que había detrás. Deja todo lo demás exactamente igual.`,
      change: `Cambia ${name}: ${text}. Deja todo lo demás exactamente igual.`,
    }[action];
    dlg.close();
    refine(instruction, { removeId: action === 'remove' ? snapshot.id : null });
  });
  // Cierra al tocar fuera del diálogo
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
}

/* ================================================================== */
/* Inicio                                                              */
/* ================================================================== */

function bindPanel() {
  const ta = $('#instructions');
  ta.addEventListener('input', () => { state.project.instructions = ta.value; saveProject(); renderGenerateState(); });
  $('#room-size').addEventListener('input', (e) => { state.project.roomSize = e.target.value; saveProject(); });
  $('#btn-example').addEventListener('click', () => {
    if (ta.value.trim() && !confirm('¿Reemplazar tu texto por el ejemplo?')) return;
    ta.value = EXAMPLE;
    ta.dispatchEvent(new Event('input'));
    ta.focus();
  });
  $('#btn-generate').addEventListener('click', generate);
  $('#refine-form').addEventListener('submit', (e) => { e.preventDefault(); refine($('#refine-input').value); });
  $('#refine-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); refine(e.target.value); }
  });
  $('#btn-download').addEventListener('click', () => downloadCurrent().catch(() => toast('No se pudo descargar la imagen.', 'error')));
  $$('.seg [data-view]').forEach((b) => b.addEventListener('click', () => { state.view = b.dataset.view; renderSlider(); }));
  $('#cmp-left').addEventListener('change', (e) => { state.compare.left = e.target.value; renderSlider(); });
  $('#cmp-right').addEventListener('change', (e) => { state.compare.right = e.target.value; renderSlider(); });

  const title = $('#result-title');
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
  title.addEventListener('blur', () => {
    const v = currentVersion();
    if (!v) return;
    const name = title.textContent.trim().slice(0, 80);
    if (name && name !== v.name) { v.name = name; safe(db.putVersion(v)); renderVersions(); renderSlider(); }
    title.textContent = v.name;
  });

  $('#btn-reset').addEventListener('click', async () => {
    if (!confirm('¿Empezar un proyecto nuevo? Se borrarán las fotos, las instrucciones y todas las versiones guardadas.')) return;
    state.project = emptyProject();
    state.versions = [];
    state.currentId = null;
    state.compare = { left: 'original', right: null };
    await safe(db.clear());
    hydrateInputs();
    renderAll();
  });
}

function hydrateInputs() {
  $('#instructions').value = state.project.instructions;
  $('#room-size').value = state.project.roomSize;
}

function renderAll() {
  renderRoom();
  renderItems();
  renderInspo();
  renderChips();
  renderStage();
  renderGenerateState();
}

async function init() {
  bindUploads();
  bindPanel();
  bindSlider();
  bindDialog();

  const saved = await safe(db.get('project'), null);
  if (saved) state.project = { ...emptyProject(), ...saved, room: { main: null, angles: [], ...(saved.room || {}) } };
  state.versions = ((await safe(db.allVersions(), [])) || []).sort((a, b) => a.createdAt - b.createdAt);
  const savedId = await safe(db.get('currentId'), null);
  state.currentId = state.versions.some((v) => v.id === savedId) ? savedId : state.versions.at(-1)?.id || null;
  state.compare.right = state.currentId;

  hydrateInputs();
  renderAll();
  loadServiceStatus();
}

init();
