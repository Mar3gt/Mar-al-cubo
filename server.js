// «Así quedaría» — servidor sin dependencias.
// Sirve la página (carpeta public/) y hace de puente con el modelo de edición de imágenes,
// para que la clave del servicio nunca llegue al navegador.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

loadDotEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY_BYTES = 60 * 1024 * 1024;
const PROVIDER_TIMEOUT_MS = Number(process.env.IMAGE_TIMEOUT_MS) || 240_000;

/* ------------------------------------------------------------------ */
/* Configuración del servicio de imágenes                              */
/* ------------------------------------------------------------------ */

function resolveProvider() {
  const wanted = (process.env.IMAGE_PROVIDER || '').trim().toLowerCase();
  const hasGemini = Boolean(process.env.GEMINI_API_KEY);
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);

  if (wanted === 'demo') {
    return { id: 'demo', label: 'Modo de prueba', model: 'sin edición', configured: true, maxImages: 16 };
  }
  if (wanted === 'gemini' || (!wanted && hasGemini)) {
    return {
      id: 'gemini',
      label: 'Google Gemini',
      model: process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image',
      configured: hasGemini,
      missing: hasGemini ? null : 'GEMINI_API_KEY',
      maxImages: 14,
    };
  }
  if (wanted === 'openai' || (!wanted && hasOpenAI)) {
    return {
      id: 'openai',
      label: 'OpenAI',
      model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
      configured: hasOpenAI,
      missing: hasOpenAI ? null : 'OPENAI_API_KEY',
      maxImages: 16,
    };
  }
  return { id: null, label: null, model: null, configured: false, missing: 'GEMINI_API_KEY u OPENAI_API_KEY', maxImages: 14 };
}

/* ------------------------------------------------------------------ */
/* Instrucciones para el modelo                                        */
/* ------------------------------------------------------------------ */

function sizeText(item) {
  const parts = [];
  if (num(item.width)) parts.push(`${num(item.width)} cm wide`);
  if (num(item.depth)) parts.push(`${num(item.depth)} cm deep`);
  if (num(item.height)) parts.push(`${num(item.height)} cm tall`);
  return parts.length
    ? `real size: ${parts.join(', ')} — respect these proportions relative to doors, windows and the floor`
    : 'no measurements given — infer a plausible real-world size from the object type and the room (approximate scale)';
}

function num(v) {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : null;
}

/**
 * Convierte la solicitud del navegador en una lista ordenada de bloques
 * { text } | { image } que cada proveedor sabe enviar.
 */
function buildRequest(body) {
  const blocks = [];
  const images = [];
  const addImage = (img, caption) => {
    const parsed = parseDataUrl(img);
    if (!parsed) throw httpError(400, 'Una de las imágenes no tiene un formato válido.');
    images.push(parsed);
    const n = images.length;
    blocks.push({ text: `Image ${n} — ${caption}` });
    blocks.push({ image: parsed });
    return n;
  };

  const items = Array.isArray(body.items) ? body.items.filter((i) => i && i.image) : [];
  const inspirations = Array.isArray(body.inspirations) ? body.inspirations.filter((i) => i && i.image) : [];
  const angles = Array.isArray(body.angles) ? body.angles.filter(Boolean) : [];
  const userText = String(body.instructions || '').trim().slice(0, 4000);
  const refineText = String(body.refine || '').trim().slice(0, 2000);
  const roomSize = String(body.roomSize || '').trim().slice(0, 200);
  const exclude = Array.isArray(body.exclude) ? body.exclude.map(clean).filter(Boolean).slice(0, 30) : [];

  if (!body.base) throw httpError(400, 'Falta la foto principal de la habitación.');

  if (body.mode === 'refine') {
    blocks.push({
      text: [
        'You are editing a photorealistic interior visualization of a real room.',
        'Image 1 is the CURRENT PROPOSAL. It is the base image: return the same image with ONLY the requested change applied.',
        'Keep the exact same camera position, framing, crop, aspect ratio, lighting, walls, floor, doors, windows and every object that the change does not mention. Do not restyle, re-color or re-arrange anything else.',
      ].join('\n'),
    });
    addImage(body.base, 'CURRENT PROPOSAL (base image to edit).');
    if (items.length) {
      blocks.push({ text: 'The following images show the real objects that appear in the proposal. If the change involves moving or re-rendering one of them, it must keep exactly this shape, color, material and texture:' });
      for (const it of items) addImage(it.image, `object «${clean(it.name)}» (${sizeText(it)}).`);
    }
    blocks.push({
      text: [
        `REQUESTED CHANGE (written by the user in Spanish): """${refineText || userText}"""`,
        'When an object is moved, re-draw it with correct perspective, scale and contact shadows at its new position and fill the area it left naturally (floor, wall, baseboard continue seamlessly).',
        'When an object is removed, reconstruct what was behind it so that no trace remains.',
        'Output one photorealistic image. No text, labels, arrows, borders or watermarks.',
      ].join('\n'),
    });
    return { blocks, images };
  }

  // Modo «crear»: editar la foto original de la habitación.
  blocks.push({
    text: [
      'You are a photorealistic interior visualization tool. Edit a REAL photograph of a room so the user can see how it would look decorated with THEIR OWN furniture and the style they describe.',
      'Image 1 is the ORIGINAL ROOM PHOTO. It is the base image to edit. Return the same room from exactly the same camera position, lens, framing, crop and aspect ratio.',
      'Preserve the architecture exactly: walls, ceiling, corners, doors, windows (position, size and view), floor material and pattern, radiators, outlets and fixed elements — unless the user explicitly asks to change one of them.',
    ].join('\n'),
  });
  addImage(body.base, 'ORIGINAL ROOM PHOTO (base image to edit).');
  if (roomSize) blocks.push({ text: `Approximate room dimensions given by the user: ${clean(roomSize)}.` });

  if (angles.length) {
    blocks.push({ text: 'The next images show the SAME room from other angles. Use them only to understand the layout, depth and where things are; do not copy their framing.' });
    angles.forEach((a, i) => addImage(a, `same room, additional angle ${i + 1} (reference only).`));
  }

  if (items.length) {
    blocks.push({
      text: [
        "The next images are the user's OWN FURNITURE AND OBJECTS. Each one must appear in the scene as the very same object — same shape, proportions, color, material, texture, legs, seams and details. Never replace them with a generic or similar-looking model.",
        'Ignore the background of these photos; take only the object. The user refers to them by the names in quotes.',
      ].join('\n'),
    });
    for (const it of items) addImage(it.image, `user's object «${clean(it.name)}» (${sizeText(it)}).`);
  }

  if (inspirations.length) {
    blocks.push({ text: 'The next images are INSPIRATION references. Take ONLY the aspect the user indicates for each one. Do not copy their furniture, room or architecture unless the note asks for it.' });
    inspirations.forEach((ins, i) => {
      const note = clean(ins.note) || 'general mood and color palette';
      addImage(ins.image, `inspiration reference #${i + 1}. Take only: «${note}».`);
    });
  }

  if (exclude.length) {
    blocks.push({ text: `Do NOT add these objects of the user in this version, even if the instructions mention them: ${exclude.map((n) => `«${n}»`).join(', ')}.` });
  }

  blocks.push({
    text: [
      `USER INSTRUCTIONS (in Spanish; objects are referred to by their names, inspiration references by their number): """${userText || 'Coloca mis objetos de forma natural y armoniosa en la habitación.'}"""`,
      'Follow the instructions about what to keep, move, add or remove. Anything the user does not mention stays as in the original photo, except that furniture explicitly listed above should be placed in the room.',
      'Integration: match the room perspective and vanishing points, keep realistic scale relative to doors (~200 cm high) and windows, add contact shadows and ambient occlusion where objects touch the floor or walls, match the color temperature and direction of the existing light, and add believable reflections on glossy floors.',
      'Output one single photorealistic photograph. No text, labels, arrows, split screens, borders or watermarks.',
    ].join('\n'),
  });

  return { blocks, images };
}

function clean(s) {
  return String(s ?? '').replace(/["«»\n\r]+/g, ' ').trim().slice(0, 300);
}

function parseDataUrl(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  return { mime: m[1] === 'image/jpg' ? 'image/jpeg' : m[1], base64: m[2].replace(/\s+/g, '') };
}

/* ------------------------------------------------------------------ */
/* Proveedores                                                         */
/* ------------------------------------------------------------------ */

const GEMINI_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

function nearestRatio(aspect, list) {
  if (!Number.isFinite(aspect) || aspect <= 0) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const r of list) {
    const [w, h] = r.split(':').map(Number);
    const diff = Math.abs(Math.log(w / h) - Math.log(aspect));
    if (diff < bestDiff) { bestDiff = diff; best = r; }
  }
  return best;
}

async function callGemini(provider, { blocks }, aspect) {
  const parts = blocks.map((b) =>
    b.image ? { inline_data: { mime_type: b.image.mime, data: b.image.base64 } } : { text: b.text },
  );
  const generationConfig = { responseModalities: ['IMAGE', 'TEXT'] };
  const ratio = nearestRatio(aspect, GEMINI_RATIOS);
  if (ratio) generationConfig.imageConfig = { aspectRatio: ratio };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(provider.model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw httpError(502, `El servicio de imágenes respondió con un error (${res.status}): ${json?.error?.message || res.statusText}`);
  }
  const cand = json.candidates?.[0];
  const outParts = cand?.content?.parts || [];
  const img = outParts.find((p) => p.inlineData?.data || p.inline_data?.data);
  if (!img) {
    const text = outParts.map((p) => p.text).filter(Boolean).join(' ').trim();
    const reason = json.promptFeedback?.blockReason || cand?.finishReason;
    throw httpError(502, `El modelo no devolvió una imagen${reason ? ` (${reason})` : ''}.${text ? ` Respuesta: ${text.slice(0, 300)}` : ''}`);
  }
  const data = img.inlineData || img.inline_data;
  return `data:${data.mimeType || data.mime_type || 'image/png'};base64,${data.data}`;
}

async function callOpenAI(provider, { blocks, images }, aspect) {
  // La API de edición de OpenAI recibe todas las imágenes como image[] y un único texto.
  // Las imágenes se numeran en el mismo orden en que se adjuntan.
  const prompt = blocks.filter((b) => b.text).map((b) => b.text).join('\n\n').slice(0, 30000);
  const form = new FormData();
  form.append('model', provider.model);
  form.append('prompt', prompt);
  form.append('n', '1');
  form.append('size', aspect > 1.15 ? '1536x1024' : aspect < 0.87 ? '1024x1536' : '1024x1024');
  if (process.env.OPENAI_IMAGE_QUALITY !== '') form.append('quality', process.env.OPENAI_IMAGE_QUALITY || 'high');
  if (process.env.OPENAI_INPUT_FIDELITY !== '') form.append('input_fidelity', process.env.OPENAI_INPUT_FIDELITY || 'high');
  images.forEach((img, i) => {
    const ext = img.mime.split('/')[1].replace('jpeg', 'jpg');
    form.append('image[]', new Blob([Buffer.from(img.base64, 'base64')], { type: img.mime }), `imagen-${i + 1}.${ext}`);
  });

  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw httpError(502, `El servicio de imágenes respondió con un error (${res.status}): ${json?.error?.message || res.statusText}`);
  }
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw httpError(502, 'El modelo no devolvió una imagen.');
  return `data:image/png;base64,${b64}`;
}

async function generate(body) {
  const provider = resolveProvider();
  if (!provider.configured) {
    throw httpError(503, `El servicio de imágenes no está configurado. Falta ${provider.missing}.`);
  }
  const request = buildRequest(body);
  if (request.images.length > provider.maxImages) {
    throw httpError(400, `Se enviaron ${request.images.length} imágenes y el modelo admite como máximo ${provider.maxImages}. Marca algunos objetos como «Dejar fuera» o quita fotos de referencia.`);
  }
  const aspect = Number(body.aspect);
  let image;
  if (provider.id === 'gemini') image = await callGemini(provider, request, aspect);
  else if (provider.id === 'openai') image = await callOpenAI(provider, request, aspect);
  else image = body.base; // demo: devuelve la imagen base sin cambios
  return { image, provider: provider.label, model: provider.model, imagesSent: request.images.length };
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(httpError(413, 'Las fotos pesan demasiado para una sola solicitud. Quita algunas referencias.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Prohibido' });
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not a file');
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No encontrado');
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname === '/api/status' && req.method === 'GET') {
      const p = resolveProvider();
      return sendJson(res, 200, {
        configured: p.configured,
        provider: p.id,
        providerLabel: p.label,
        model: p.model,
        missing: p.configured ? null : p.missing,
        maxImages: p.maxImages,
        demo: p.id === 'demo',
      });
    }
    if (pathname === '/api/generate') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Método no permitido' });
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        if (e.status) throw e;
        throw httpError(400, 'La solicitud no es válida.');
      }
      const started = Date.now();
      const result = await generate(body);
      console.log(`[generar] ${body.mode || 'create'} · ${result.imagesSent} imágenes · ${((Date.now() - started) / 1000).toFixed(1)} s`);
      return sendJson(res, 200, result);
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
    sendJson(res, 404, { error: 'No encontrado' });
  } catch (err) {
    const status = err.status || (err.name === 'TimeoutError' ? 504 : 500);
    const message =
      err.name === 'TimeoutError'
        ? 'El servicio de imágenes tardó demasiado en responder. Inténtalo de nuevo.'
        : err.status
          ? err.message
          : 'Ocurrió un error inesperado al generar la imagen.';
    if (!err.status) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: message });
  }
});

server.requestTimeout = PROVIDER_TIMEOUT_MS + 30_000;
server.listen(PORT, () => {
  const p = resolveProvider();
  console.log(`Así quedaría → http://localhost:${PORT}`);
  console.log(p.configured ? `Servicio de imágenes: ${p.label} (${p.model})` : `Servicio de imágenes sin configurar: falta ${p.missing}.`);
});

/* ------------------------------------------------------------------ */

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
