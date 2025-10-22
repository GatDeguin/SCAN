import { describe, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { Blob as NodeBlob } from 'node:buffer';

const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
const inventoryCsv = fs.readFileSync(path.join(process.cwd(), 'inventario.csv'), 'utf8');

async function waitFor(fn, { window }, timeout = 500) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        if (fn()) {
          resolve();
          return;
        }
      } catch (err) {
        reject(err);
        return;
      }
      if (Date.now() - start > timeout) {
        reject(new Error('Timeout waiting for condition'));
        return;
      }
      window.setTimeout(check, 5);
    };
    check();
  });
}

async function createApp({ inventory = inventoryCsv } = {}) {
  const fetchMock = vi.fn(async (url) => {
    const target = typeof url === 'string' ? url : url?.url || '';
    if (target.endsWith('inventario.csv')) {
      return {
        ok: true,
        status: 200,
        text: async () => inventory,
      };
    }
    return {
      ok: false,
      status: 404,
      text: async () => '',
    };
  });

  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.alert = vi.fn();
      window.confirm = vi.fn(() => true);
      window.navigator.mediaDevices = {
        enumerateDevices: vi.fn(() => Promise.resolve([])),
        getUserMedia: vi.fn(() => Promise.reject(new Error('not implemented'))),
      };
      window.navigator.clipboard = { writeText: vi.fn() };
      window.BarcodeDetector = class {
        detect() {
          return Promise.resolve([]);
        }
      };
      window.createImageBitmap = vi.fn(async () => ({ close() {} }));
      window.requestAnimationFrame = () => 0;
      window.cancelAnimationFrame = () => {};
      window.performance = window.performance || { now: () => Date.now() };
      window.fetch = fetchMock;
      window.Blob = NodeBlob;
      window.HTMLCanvasElement.prototype.getContext = () => ({
        clearRect() {},
        save() {},
        translate() {},
        rotate() {},
        fillRect() {},
        restore() {},
        fillStyle: '',
      });
    },
  });

  const { window } = dom;
  window.URL.createObjectURL = vi.fn(() => 'blob:mock');
  window.URL.revokeObjectURL = vi.fn();
  const originalAppendChild = window.document.body.appendChild.bind(window.document.body);
  window.document.body.appendChild = function append(node) {
    return originalAppendChild(node);
  };

  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  await new Promise((resolve) => window.setTimeout(resolve, 0));

  const app = window.__SCAN__;
  if (!app) {
    throw new Error('App not loaded');
  }

  await waitFor(() => app.state.inventory.length > 0, { window }, 2000);

  return { dom, window, document: window.document, app, fetchMock };
}

function closeApp({ dom }) {
  dom?.window?.close();
}

describe('Mini App Inventario – auditoría funcional', () => {
  it('carga inventario por defecto y prepara la vista previa', async () => {
    const ctx = await createApp();
    const { app, document, fetchMock } = ctx;
    expect(fetchMock).toHaveBeenCalled();
    expect(app.state.inventory).toHaveLength(6);
    expect(app.state.columns).toEqual(['Nro.Inventario', 'Denominación del Bien']);
    expect(app.state.key).toBe('Nro.Inventario');
    expect(document.querySelector('#invCount').textContent).toBe('6 ítems');
    expect(document.querySelector('#visibleCount').textContent).toBe('6 visibles');
    closeApp(ctx);
  });

  it('detecta delimitadores y respeta comillas en CSV', async () => {
    const ctx = await createApp();
    const { app } = ctx;
    const sample = 'codigo,desc\n001,"Item, uno"\n';
    const parsed = app.parseCSVAuto(sample);
    expect(parsed.delimiter).toBe(',');
    expect(parsed.rows[1][1]).toBe('Item, uno');

    const sample2 = '\uFEFFcodigo;desc\n001;"Item; dos"\n';
    const parsed2 = app.parseCSVAuto(sample2);
    expect(parsed2.delimiter).toBe(';');
    expect(parsed2.rows[1][1]).toBe('Item; dos');
    closeApp(ctx);
  });

  it('filtra inventario y actualiza contador visible', async () => {
    const ctx = await createApp();
    const { app, document } = ctx;
    const filterInput = document.querySelector('#filterInput');
    filterInput.value = 'tipo "c"';
    app.paintInventory();
    expect(document.querySelector('#visibleCount').textContent).toBe('1 visibles');
    filterInput.value = 'sin resultados';
    app.paintInventory();
    expect(document.querySelector('#visibleCount').textContent).toBe('0 visibles');
    closeApp(ctx);
  });

  it('marca coincidencias del inventario y muestra detalles', async () => {
    const ctx = await createApp();
    const { app, document } = ctx;
    app.onDetect('400-11-1831');
    expect(document.querySelector('#detectedCode').value).toBe('400-11-1831');
    const chip = document.querySelector('#matchChip');
    expect(chip.textContent).toBe('Coincide en inventario');
    expect(chip.classList.contains('ok')).toBe(true);
    expect(document.querySelector('#detailTable').classList.contains('hidden')).toBe(false);
    expect(document.querySelectorAll('#detailTbl tr')).toHaveLength(app.state.columns.length);
    closeApp(ctx);
  });

  it('identifica códigos ausentes y limpia detalles', async () => {
    const ctx = await createApp();
    const { app, document } = ctx;
    app.onDetect('000-00-0000');
    const chip = document.querySelector('#matchChip');
    expect(chip.textContent).toBe('No encontrado en inventario');
    expect(chip.classList.contains('bad')).toBe(true);
    expect(document.querySelector('#detailTable').classList.contains('hidden')).toBe(true);
    closeApp(ctx);
  });

  it('agrega conformados, persiste y exporta CSV con delimitador original', async () => {
    const ctx = await createApp();
    const { app, document, window } = ctx;
    app.onDetect('400-11-1831');
    document.querySelector('#confirmBtn').click();
    expect(app.state.conformados).toHaveLength(1);
    expect(document.querySelector('#confCount').textContent).toBe('1');
    const stored = window.localStorage.getItem('conformados_v1');
    expect(stored).not.toBeNull();

    let clicked = false;
    const originalAppendChild = document.body.appendChild.bind(document.body);
    document.body.appendChild = function append(node) {
      if (node.tagName === 'A') {
        node.click = () => { clicked = true; };
      }
      return originalAppendChild(node);
    };

    app.exportCSV();
    expect(window.URL.createObjectURL).toHaveBeenCalledTimes(1);
    const blob = window.URL.createObjectURL.mock.calls[0][0];
    const buffer = await (typeof blob.arrayBuffer === 'function'
      ? blob.arrayBuffer()
      : new Response(blob).arrayBuffer());
    const prefix = Array.from(new Uint8Array(buffer.slice(0, 3)));
    expect(prefix).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder('utf-8').decode(buffer);
    expect(text).toContain('"timestamp";"codigo";"_match";"Nro.Inventario";"Denominación del Bien"');
    expect(text).toContain('400-11-1831');
    expect(clicked).toBe(true);
    document.body.appendChild = originalAppendChild;
    closeApp(ctx);
  });

  it('limpia conformados tras confirmación del usuario', async () => {
    const ctx = await createApp();
    const { app, document, window } = ctx;
    app.onDetect('400-11-1831');
    document.querySelector('#confirmBtn').click();
    expect(app.state.conformados).toHaveLength(1);
    window.confirm.mockImplementation(() => true);
    document.querySelector('#clearBtn').click();
    expect(window.confirm).toHaveBeenCalled();
    expect(app.state.conformados).toHaveLength(0);
    expect(document.querySelector('#confCount').textContent).toBe('0');
    closeApp(ctx);
  });

  it('carga archivos CSV manuales conservando columnas únicas', async () => {
    const ctx = await createApp();
    const { app, document } = ctx;
    const file = {
      name: 'manual.csv',
      text: async () => 'id,nombre,id\n1,Alpha,extra\n2,Beta,extra2\n',
    };
    await app.loadFile(file);
    expect(app.state.inventory).toHaveLength(2);
    expect(app.state.columns).toEqual(['id', 'nombre', 'id_2']);
    expect(document.querySelector('#invCount').textContent).toBe('2 ítems');
    closeApp(ctx);
  });
});
