const BARCODE_FORMATS = [
  'aztec',
  'code_128',
  'code_39',
  'code_93',
  'codabar',
  'data_matrix',
  'ean_13',
  'ean_8',
  'itf',
  'pdf417',
  'qr_code',
  'upc_a',
  'upc_e',
];

const ZXING_FORMAT_MAP = {
  aztec: 'AZTEC',
  code_128: 'CODE_128',
  code_39: 'CODE_39',
  code_93: 'CODE_93',
  codabar: 'CODABAR',
  data_matrix: 'DATA_MATRIX',
  ean_13: 'EAN_13',
  ean_8: 'EAN_8',
  itf: 'ITF',
  pdf417: 'PDF_417',
  qr_code: 'QR_CODE',
  upc_a: 'UPC_A',
  upc_e: 'UPC_E',
};

const DETECT_EVERY_MS = 160;
const MANUAL_DETECT_DELAY_MS = 120;

class ScanControlApp {
  constructor(doc) {
    this.document = doc;
    this.window = doc?.defaultView || (typeof window !== 'undefined' ? window : undefined);
    this.state = {
      inventory: [],
      inventoryName: '',
      columns: [],
      key: null,
      index: new Map(),
      conformados: [],
      exportDelimiter: ',',
      scanning: false,
      lastScan: { code: '', time: 0 },
      cameraDevices: [],
      currentDeviceId: null,
      torchOn: false,
      detector: null,
      fallbackReader: null,
      fallbackErrorShown: false,
    };

    this.refs = {};
    this.scanLabelTimer = null;
    this.manualScanBusy = false;
    this.detectLoopHandle = null;
    this.lastDetectTs = 0;

    this.barcodeDetectorAvailable = undefined;
    this.barcodeDetectorFormatsPromise = null;
    this.barcodeDetectorFormatsCache = null;
    this.barcodeDetectorSupportsVideo = undefined;
    this.barcodeDetectorSupportsBitmap = undefined;

    this.ensureZXingPromise = null;
    this.detectionCanvas = null;
    this.detectionCanvasCtx = null;

    this.detectLoop = this.detectLoop.bind(this);
  }

  bootstrap() {
    if (!this.document) return;
    this.cacheRefs();
    this.bindUI();
    this.restoreConformados();
    this.updateInventoryIndicators();
    this.setInventoryStatus('Buscando inventario predeterminado…', 'info');
    this.initDevices().catch((err) => {
      console.warn('No se pudieron inicializar dispositivos de cámara', err);
    });
    this.loadDefaultInventory();
  }

  cacheRefs() {
    const ids = {
      apiStatus: '#apiStatus',
      autoLoadMsg: '#autoLoadMsg',
      confirmBtn: '#confirmBtn',
      confirmBtnMobile: '#confirmBtnMobile',
      copyBtn: '#copyBtn',
      confCount: '#confCount',
      confTbl: '#confTbl',
      detectedCode: '#detectedCode',
      detailTable: '#detailTable',
      detailTableWrap: '#detailTableWrap',
      detailTbl: '#detailTbl',
      drop: '#drop',
      exportBtn: '#exportBtn',
      exportBtnMobile: '#exportBtnMobile',
      filterInput: '#filterInput',
      filterInputDrawer: '#filterInputDrawer',
      flashBtn: '#flashBtn',
      inventoryClose: '#inventoryClose',
      inventoryDrawer: '#inventoryDrawer',
      inventoryStatus: '#inventoryStatus',
      inventoryToggle: '#inventoryToggle',
      invCount: '#invCount',
      invTbl: '#invTbl',
      invTblDrawer: '#invTblDrawer',
      keyIndicator: '#keyIndicator',
      keySelect: '#keySelect',
      keySelectDrawer: '#keySelectDrawer',
      manualBtn: '#manualBtn',
      manualInput: '#manualInput',
      matchChip: '#matchChip',
      noData: '#noData',
      pulse: '#pulse',
      scanLabel: '#scanLabel',
      scanOnceBtn: '#scanOnceBtn',
      startBtn: '#startBtn',
      stopBtn: '#stopBtn',
      switchBtn: '#switchBtn',
      video: '#video',
      visibleCount: '#visibleCount',
      fileInput: '#fileInput',
      btnTestCSV: '#btnTestCSV',
      btnTestExport: '#btnTestExport',
      clearBtn: '#clearBtn',
    };

    Object.entries(ids).forEach(([key, selector]) => {
      this.refs[key] = this.document.querySelector(selector);
    });
  }

  bindUI() {
    const {
      inventoryToggle,
      inventoryClose,
      inventoryDrawer,
      keySelect,
      keySelectDrawer,
      filterInput,
      filterInputDrawer,
      drop,
      fileInput,
      startBtn,
      stopBtn,
      flashBtn,
      switchBtn,
      scanOnceBtn,
      manualBtn,
      manualInput,
      confirmBtn,
      confirmBtnMobile,
      copyBtn,
      exportBtn,
      exportBtnMobile,
      clearBtn,
      btnTestCSV,
      btnTestExport,
    } = this.refs;

    inventoryToggle?.addEventListener('click', () => this.toggleInventoryDrawer());
    inventoryClose?.addEventListener('click', () => this.toggleInventoryDrawer(false));
    inventoryDrawer?.addEventListener('click', (event) => {
      if (event.target === inventoryDrawer) {
        this.toggleInventoryDrawer(false);
      }
    });

    this.document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !inventoryDrawer?.classList.contains('hidden')) {
        this.toggleInventoryDrawer(false);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        this.refs.confirmBtn?.click();
      }
    });

    keySelect?.addEventListener('change', (event) => {
      const value = event.target.value;
      this.syncKeySelects(value, 'main');
      this.state.key = value;
      this.rebuildIndex();
    });

    keySelectDrawer?.addEventListener('change', (event) => {
      const value = event.target.value;
      this.syncKeySelects(value, 'drawer');
      this.state.key = value;
      this.rebuildIndex();
    });

    const handleFilterInput = (value, source) => {
      this.syncFilters(value, source);
      this.paintInventory();
    };

    filterInput?.addEventListener('input', (event) => {
      handleFilterInput(event.target.value, 'main');
    });

    filterInputDrawer?.addEventListener('input', (event) => {
      handleFilterInput(event.target.value, 'drawer');
    });

    const preventDefaults = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };

    if (drop) {
      ['dragenter', 'dragover'].forEach((type) => {
        drop.addEventListener(type, (event) => {
          preventDefaults(event);
          drop.classList.add('drag');
        });
      });

      ['dragleave', 'dragend'].forEach((type) => {
        drop.addEventListener(type, (event) => {
          preventDefaults(event);
          drop.classList.remove('drag');
        });
      });

      drop.addEventListener('drop', (event) => {
        preventDefaults(event);
        drop.classList.remove('drag');
        const file = event.dataTransfer?.files?.[0];
        if (file) {
          this.loadFile(file);
        }
      });

      drop.addEventListener('click', () => fileInput?.click());
      drop.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          fileInput?.click();
        }
      });
    }

    fileInput?.addEventListener('change', (event) => {
      const file = event.target.files?.[0];
      if (file) {
        this.loadFile(file);
      }
      event.target.value = '';
    });

    startBtn?.addEventListener('click', () => this.startCamera());
    stopBtn?.addEventListener('click', () => this.stopCamera());
    flashBtn?.addEventListener('click', () => this.toggleTorch());
    switchBtn?.addEventListener('click', () => this.switchCamera());
    scanOnceBtn?.addEventListener('click', () => this.scanOnce());

    const manualSubmit = () => {
      const value = manualInput?.value?.trim();
      if (!value) return;
      this.onDetect(value);
      if (manualInput) manualInput.value = '';
    };

    manualBtn?.addEventListener('click', manualSubmit);
    manualInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        manualSubmit();
      }
    });

    const confirmAction = () => {
      const code = this.refs.detectedCode?.value;
      if (!code) return;
      this.addConformado(code);
    };

    confirmBtn?.addEventListener('click', confirmAction);
    confirmBtnMobile?.addEventListener('click', confirmAction);

    copyBtn?.addEventListener('click', async () => {
      const code = this.refs.detectedCode?.value;
      if (!code) return;
      try {
        await this.window?.navigator?.clipboard?.writeText(code);
        this.setScanLabel('Código copiado', 1600);
      } catch (err) {
        console.warn('No se pudo copiar al portapapeles', err);
      }
    });

    exportBtn?.addEventListener('click', () => this.exportCSV());
    exportBtnMobile?.addEventListener('click', () => this.exportCSV());

    clearBtn?.addEventListener('click', () => {
      if (!this.window?.confirm || this.window.confirm('¿Vaciar la lista de conformados?')) {
        this.state.conformados = [];
        this.persistConformados();
        this.paintConformados();
      }
    });

    btnTestCSV?.addEventListener('click', () => {
      const sample = 'codigo,desc,qty\r\n123,Item A,5\r\n"124,7",Item B,10\r\n125,"Item, C",0\r\n';
      const parsedA = this.parseCSVAuto(sample);
      console.assert(parsedA.rows.length === 4, 'CSV coma: 4 filas contando header');
      console.assert(parsedA.rows[2][0] === '124,7', 'CSV coma: campo con coma entre comillas');

      const sampleB = '\ufeffcodigo;desc;qty\n001;Item A;5\n002;"Item; B";3\n';
      const parsedB = this.parseCSVAuto(sampleB);
      console.assert(parsedB.delimiter === ';', 'CSV punto y coma detectado');
      console.assert(parsedB.rows[2][1] === 'Item; B', 'CSV punto y coma respeta comillas internas');
      console.log('✅ Test CSV OK', { coma: parsedA, puntoYComa: parsedB });
    });

    btnTestExport?.addEventListener('click', () => {
      this.state.columns = ['codigo', 'desc'];
      this.state.exportDelimiter = ';';
      this.state.conformados = [
        { timestamp: '2025-10-22T12:00:00Z', codigo: 'ABC', _match: '1', desc: 'Algo' },
        { timestamp: '2025-10-22T12:01:00Z', codigo: 'XYZ', _match: '0', desc: 'Otra' },
      ];
      this.exportCSV();
      console.log('✅ Test export OK (deberías ver un archivo descargado)');
    });
  }

  syncKeySelects(value, source) {
    if (source !== 'main' && this.refs.keySelect && this.refs.keySelect.value !== value) {
      this.refs.keySelect.value = value;
    }
    if (source !== 'drawer' && this.refs.keySelectDrawer && this.refs.keySelectDrawer.value !== value) {
      this.refs.keySelectDrawer.value = value;
    }
  }

  syncFilters(value, source) {
    if (source !== 'main' && this.refs.filterInput && this.refs.filterInput.value !== value) {
      this.refs.filterInput.value = value;
    }
    if (source !== 'drawer' && this.refs.filterInputDrawer && this.refs.filterInputDrawer.value !== value) {
      this.refs.filterInputDrawer.value = value;
    }
  }

  getFilterValue() {
    return this.refs.filterInput?.value || this.refs.filterInputDrawer?.value || '';
  }

  formatCount(value, singular, plural) {
    const count = Number(value) || 0;
    return `${count} ${count === 1 ? singular : plural}`;
  }

  setChip(selectorOrElement, text, ok = null) {
    const el = typeof selectorOrElement === 'string'
      ? this.document.querySelector(selectorOrElement)
      : selectorOrElement;
    if (!el) return;
    el.textContent = text;
    el.classList.remove('ok', 'bad');
    if (ok === true) {
      el.classList.add('ok');
    } else if (ok === false) {
      el.classList.add('bad');
    }
  }

  setScanLabel(text, revertMs = null) {
    const label = this.refs.scanLabel;
    if (!label) return;
    label.textContent = text;
    if (this.scanLabelTimer) {
      this.window?.clearTimeout(this.scanLabelTimer);
      this.scanLabelTimer = null;
    }
    if (revertMs !== null && this.state.scanning) {
      this.scanLabelTimer = this.window?.setTimeout(() => {
        this.scanLabelTimer = null;
        if (this.state.scanning) {
          label.textContent = 'Escaneando…';
        }
      }, revertMs);
    }
  }

  setInventoryStatus(text = '', tone = 'info') {
    const targets = [this.refs.inventoryStatus, this.refs.autoLoadMsg];
    const classes = ['success', 'error', 'warn'];
    targets.forEach((target) => {
      if (!target) return;
      target.textContent = text;
      target.classList.remove(...classes);
      if (tone === 'success') target.classList.add('success');
      else if (tone === 'error') target.classList.add('error');
      else if (tone === 'warn') target.classList.add('warn');
    });
  }

  updateInventoryIndicators() {
    const total = this.state.inventory.length;
    if (this.refs.invCount) {
      this.refs.invCount.textContent = this.formatCount(total, 'ítem', 'ítems');
      this.refs.invCount.title = this.state.inventoryName
        ? `Inventario: ${this.state.inventoryName}`
        : '';
    }
    if (this.refs.keyIndicator) {
      this.refs.keyIndicator.textContent = this.state.key ? `Clave: ${this.state.key}` : 'Clave: —';
    }
    if (this.refs.inventoryToggle) {
      this.refs.inventoryToggle.disabled = total === 0;
      this.refs.inventoryToggle.title = total === 0
        ? 'Importá un inventario para habilitar esta vista'
        : this.state.inventoryName ? `Inventario: ${this.state.inventoryName}` : 'Abrir panel de inventario';
    }
  }

  toggleInventoryDrawer(open) {
    const drawer = this.refs.inventoryDrawer;
    if (!drawer) return;
    const shouldOpen = typeof open === 'boolean' ? open : drawer.classList.contains('hidden');
    if (shouldOpen) {
      drawer.classList.remove('hidden');
      drawer.setAttribute('aria-hidden', 'false');
      this.refs.inventoryToggle?.setAttribute('aria-expanded', 'true');
      this.window?.requestAnimationFrame(() => {
        this.refs.inventoryClose?.focus();
      });
    } else {
      drawer.classList.add('hidden');
      drawer.setAttribute('aria-hidden', 'true');
      this.refs.inventoryToggle?.setAttribute('aria-expanded', 'false');
      this.refs.inventoryToggle?.focus();
    }
  }

  stripBom(text) {
    return text.replace(/^\ufeff/, '');
  }

  detectDelimiter(text) {
    const sample = this.stripBom(text)
      .split(/\r?\n/)
      .find((line) => line.trim().length) || '';
    const candidates = [',', ';', '\t', '|'];
    let best = ',';
    let bestCount = 0;
    for (const delimiter of candidates) {
      let count = 0;
      let inQuote = false;
      for (let i = 0; i < sample.length; i += 1) {
        const ch = sample[i];
        if (ch === '"') {
          if (inQuote && sample[i + 1] === '"') {
            i += 1;
          }
          inQuote = !inQuote;
        } else if (ch === delimiter && !inQuote) {
          count += 1;
        }
      }
      if (count > bestCount) {
        best = delimiter;
        bestCount = count;
      }
    }
    return bestCount > 0 ? best : ',';
  }

  parseCSV(text, delimiter = ',') {
    const clean = this.stripBom(text);
    const rows = [];
    let current = '';
    let row = [];
    let inQuote = false;
    for (let i = 0; i < clean.length; i += 1) {
      const ch = clean[i];
      const next = clean[i + 1];
      if (ch === '"') {
        if (inQuote && next === '"') {
          current += '"';
          i += 1;
        } else {
          inQuote = !inQuote;
        }
      } else if (ch === delimiter && !inQuote) {
        row.push(current);
        current = '';
      } else if ((ch === '\n' || ch === '\r') && !inQuote) {
        if (ch === '\r' && next === '\n') {
          i += 1;
        }
        if (current !== '' || row.length) {
          row.push(current);
          rows.push(row);
          row = [];
          current = '';
        }
      } else {
        current += ch;
      }
    }
    if (current !== '' || row.length) {
      row.push(current);
      rows.push(row);
    }
    return rows;
  }

  parseCSVAuto(text) {
    const delimiter = this.detectDelimiter(text);
    const rows = this.parseCSV(text, delimiter)
      .filter((r) => Array.isArray(r) && r.some((c) => String(c ?? '').trim() !== ''));
    return { rows, delimiter };
  }

  uniqueColumnNames(header) {
    const seen = new Set();
    return header.map((name, index) => {
      let base = String(name ?? '').replace(/\ufeff/g, '').trim();
      if (!base) {
        base = `col_${index + 1}`;
      }
      let final = base;
      let counter = 2;
      while (seen.has(final)) {
        final = `${base}_${counter}`;
        counter += 1;
      }
      seen.add(final);
      return final;
    });
  }

  normalizeRowValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.replace(/\ufeff/g, '').trim();
    return String(value);
  }

  hydrateInventory(rows, { name = 'inventario', delimiter } = {}) {
    if (!rows.length) {
      this.window?.alert?.('El archivo está vacío.');
      this.setInventoryStatus('El archivo no contiene registros.', 'error');
      return;
    }
    const [header, ...data] = rows;
    this.state.columns = this.uniqueColumnNames(header);
    this.state.inventory = data
      .filter((row) => Array.isArray(row) && row.some((cell) => String(cell ?? '').trim() !== ''))
      .map((row) => Object.fromEntries(
        this.state.columns.map((col, index) => [col, this.normalizeRowValue(row[index])]),
      ));
    if (!this.state.columns.length) {
      this.setInventoryStatus('No se detectaron columnas en el archivo.', 'error');
      return;
    }
    this.state.inventoryName = name;
    if (delimiter) {
      this.state.exportDelimiter = delimiter;
    }
    this.syncFilters('', 'main');
    const normalizedColumns = this.state.columns.map((c) => c.toLowerCase());
    const guess = [
      'codigo', 'código', 'barcode', 'barra', 'ean', 'sku', 'id', 'inventario', 'cod_barra', 'code', 'nro.inventario',
    ].find((candidate) => normalizedColumns.includes(candidate));
    this.state.key = guess || this.state.columns[0];
    this.syncKeySelects(this.state.key, null);
    this.rebuildIndex();
    this.paintInventory();
    this.fillKeySelect();
    this.paintConformados();
    this.updateInventoryIndicators();
    this.setInventoryStatus(`Inventario cargado${name ? ` (${name})` : ''}: ${this.state.inventory.length} ítems disponibles.`, 'success');
  }

  rebuildIndex() {
    this.state.index = new Map();
    if (!this.state.columns.includes(this.state.key)) {
      this.state.key = this.state.columns[0] || null;
      this.syncKeySelects(this.state.key, null);
    }
    if (!this.state.key) {
      this.updateInventoryIndicators();
      return;
    }
    for (const row of this.state.inventory) {
      const code = String(row[this.state.key] ?? '').trim();
      if (code) {
        this.state.index.set(code, row);
      }
    }
    this.updateInventoryIndicators();
    this.paintInventory();
  }

  fillKeySelect() {
    const renderOptions = (select) => {
      if (!select) return;
      select.innerHTML = '';
      for (const col of this.state.columns) {
        const option = this.document.createElement('option');
        option.value = col;
        option.textContent = col;
        if (col === this.state.key) {
          option.selected = true;
        }
        select.appendChild(option);
      }
    };
    renderOptions(this.refs.keySelect);
    renderOptions(this.refs.keySelectDrawer);
  }

  filterMatches(row, filter) {
    if (!filter) return true;
    const normalized = filter.trim().toLowerCase();
    if (!normalized) return true;
    return this.state.columns.some((col) => String(row[col] ?? '').toLowerCase().includes(normalized));
  }

  paintInventory() {
    const columns = this.state.columns;
    const filter = this.getFilterValue();
    const filtered = this.state.inventory.filter((row) => this.filterMatches(row, filter));
    const previewLimit = 120;
    this.renderInventoryTable(this.refs.invTbl, filtered.slice(0, previewLimit), columns);
    this.renderInventoryTable(this.refs.invTblDrawer, filtered, columns);
    if (this.refs.visibleCount) {
      this.refs.visibleCount.textContent = `${filtered.length} visibles`;
    }
  }

  renderInventoryTable(table, rows, columns) {
    if (!table) return;
    table.innerHTML = '';
    if (!columns.length) return;
    const head = this.document.createElement('tr');
    columns.forEach((column) => {
      const th = this.document.createElement('th');
      th.textContent = column;
      head.appendChild(th);
    });
    table.appendChild(head);
    rows.forEach((row) => {
      const tr = this.document.createElement('tr');
      columns.forEach((column) => {
        const td = this.document.createElement('td');
        td.textContent = String(row[column] ?? '');
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
  }

  clearDetails() {
    if (this.refs.detailTbl) {
      this.refs.detailTbl.innerHTML = '';
    }
    this.refs.noData?.classList.remove('hidden');
    this.refs.detailTable?.classList.add('hidden');
  }

  paintDetails(row) {
    if (!this.refs.detailTbl) return;
    this.refs.detailTbl.innerHTML = '';
    for (const col of this.state.columns) {
      const tr = this.document.createElement('tr');
      const th = this.document.createElement('th');
      th.textContent = col;
      const td = this.document.createElement('td');
      td.textContent = String(row[col] ?? '');
      tr.appendChild(th);
      tr.appendChild(td);
      this.refs.detailTbl.appendChild(tr);
    }
    this.refs.noData?.classList.add('hidden');
    this.refs.detailTable?.classList.remove('hidden');
  }

  flashCard(tone) {
    const card = this.document.querySelector('.details');
    if (!card) return;
    const colors = {
      ok: '0 0 0 2px rgba(93,236,154,0.5)',
      warn: '0 0 0 2px rgba(255,179,71,0.6)',
    };
    const shadow = colors[tone] || '0 0 0 2px rgba(124,241,212,0.45)';
    card.style.boxShadow = shadow;
    this.window?.setTimeout(() => {
      card.style.boxShadow = '';
    }, 320);
  }

  flashOK() {
    this.flashCard('ok');
  }

  flashWarn() {
    this.flashCard('warn');
  }

  addConformado(code) {
    const normalized = String(code || '').trim();
    if (!normalized) return;
    if (this.state.conformados.some((record) => record.codigo === normalized)) {
      this.setScanLabel('Código ya conformado', 2000);
      return;
    }
    const timestamp = new Date().toISOString();
    const row = this.state.index.get(normalized) || null;
    const record = { codigo: normalized, timestamp, _match: row ? '1' : '0' };
    if (row) {
      for (const col of this.state.columns) {
        record[col] = row[col] ?? '';
      }
    }
    this.state.conformados.unshift(record);
    this.persistConformados();
    this.paintConformados();
    this.confetti(this.window?.innerWidth ? this.window.innerWidth - 180 : 240, 140);
  }

  paintConformados() {
    const table = this.refs.confTbl;
    if (!table) return;
    table.innerHTML = '';
    const columns = ['timestamp', 'codigo', '_match', ...this.state.columns.slice(0, 4)];
    if (!columns.length) return;
    const head = this.document.createElement('tr');
    columns.forEach((col) => {
      const th = this.document.createElement('th');
      th.textContent = col;
      head.appendChild(th);
    });
    table.appendChild(head);
    for (const record of this.state.conformados) {
      const tr = this.document.createElement('tr');
      tr.classList.add('added');
      columns.forEach((col) => {
        const td = this.document.createElement('td');
        td.textContent = String(record[col] ?? '');
        tr.appendChild(td);
      });
      table.appendChild(tr);
    }
    if (this.refs.confCount) {
      this.refs.confCount.textContent = String(this.state.conformados.length);
    }
  }

  exportCSV() {
    if (!this.state.conformados.length) {
      this.window?.alert?.('No hay registros para exportar.');
      return;
    }
    const columns = Array.from(new Set(['timestamp', 'codigo', '_match', ...this.state.columns]));
    const escapeCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const delimiter = this.state.exportDelimiter || ',';
    const lines = [columns.map(escapeCell).join(delimiter)];
    this.state.conformados.forEach((record) => {
      lines.push(columns.map((col) => escapeCell(record[col])).join(delimiter));
    });
    const blob = new Blob([`\ufeff${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8;' });
    const url = this.window?.URL?.createObjectURL?.(blob);
    if (!url) return;
    const anchor = this.document.createElement('a');
    anchor.href = url;
    anchor.download = 'conformado.csv';
    this.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    this.window.URL.revokeObjectURL(url);
  }

  persistConformados() {
    try {
      this.window?.localStorage?.setItem('conformados_v1', JSON.stringify(this.state.conformados));
    } catch (err) {
      console.warn('No se pudo persistir conformados', err);
    }
  }

  restoreConformados() {
    try {
      const stored = this.window?.localStorage?.getItem('conformados_v1');
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        this.state.conformados = parsed;
      }
    } catch (err) {
      console.warn('No se pudieron restaurar conformados', err);
    }
    this.paintConformados();
  }

  async ensureSheetJS() {
    if (this.window?.XLSX) return;
    await new Promise((resolve) => {
      const script = this.document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
      script.onload = resolve;
      script.onerror = resolve;
      this.document.head.appendChild(script);
    });
  }

  async ensureZXing() {
    if (this.window?.ZXing?.BrowserMultiFormatReader) {
      return this.window.ZXing;
    }
    if (this.ensureZXingPromise) return this.ensureZXingPromise;
    this.ensureZXingPromise = new Promise((resolve) => {
      const script = this.document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.20.0/umd/index.min.js';
      script.onload = () => resolve(this.window?.ZXing || null);
      script.onerror = () => resolve(null);
      this.document.head.appendChild(script);
    });
    const lib = await this.ensureZXingPromise;
    if (!lib?.BrowserMultiFormatReader) {
      this.ensureZXingPromise = null;
      return null;
    }
    return lib;
  }

  async loadFile(file) {
    if (!file) return;
    try {
      const name = file.name || 'inventario';
      const lower = name.toLowerCase();
      if (lower.endsWith('.csv')) {
        const text = await file.text();
        const { rows, delimiter } = this.parseCSVAuto(text);
        this.hydrateInventory(rows, { name, delimiter });
      } else if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
        await this.ensureSheetJS();
        if (!this.window?.XLSX) {
          this.window?.alert?.('No se pudo cargar el lector de Excel. Exportá a CSV e intentá nuevamente.');
          this.setInventoryStatus('No se pudo cargar el lector de Excel. Preferí CSV para uso offline.', 'warn');
          return;
        }
        const buffer = await file.arrayBuffer();
        const workbook = this.window.XLSX.read(buffer, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = this.window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        this.hydrateInventory(rows, { name });
      } else {
        this.window?.alert?.('Formato no soportado. Usá CSV o Excel (.xlsx).');
        this.setInventoryStatus('Formato no soportado. Seleccioná un CSV o Excel.', 'error');
      }
    } catch (error) {
      console.error('Error al leer archivo', error);
      this.window?.alert?.('Ocurrió un problema al leer el archivo. Revisá el formato e intentá nuevamente.');
      this.setInventoryStatus('No se pudo cargar el archivo seleccionado.', 'error');
    }
  }

  async loadDefaultInventory() {
    try {
      const response = await this.window?.fetch?.('inventario.csv', { cache: 'no-store' });
      if (!response?.ok) {
        throw new Error(`HTTP ${response?.status || 0}`);
      }
      const text = await response.text();
      if (!text.trim()) {
        throw new Error('Archivo vacío');
      }
      const { rows, delimiter } = this.parseCSVAuto(text);
      this.hydrateInventory(rows, { name: 'inventario.csv', delimiter });
    } catch (error) {
      console.info('Inventario automático no disponible:', error);
      const manualMessage = this.window?.location?.protocol === 'file:'
        ? 'Abrí este archivo desde un servidor o seleccioná el inventario manualmente.'
        : 'Seleccioná un archivo usando el botón "Buscar archivo" o arrastralo al recuadro.';
      this.setInventoryStatus(manualMessage, 'warn');
    }
  }

  async initDevices() {
    const nav = this.window?.navigator;
    if (!nav?.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await nav.mediaDevices.enumerateDevices();
      this.state.cameraDevices = devices.filter((device) => device.kind === 'videoinput');
      if (this.state.cameraDevices.length > 0 && !this.state.currentDeviceId) {
        const environment = this.state.cameraDevices.find((device) => /back|rear|environment/i.test(device.label));
        this.state.currentDeviceId = (environment || this.state.cameraDevices[0]).deviceId;
      }
      if (this.refs.switchBtn) {
        this.refs.switchBtn.disabled = this.state.cameraDevices.length < 2;
      }
    } catch (error) {
      console.warn('No se pudieron enumerar dispositivos de vídeo', error);
    }
  }

  async startCamera() {
    if (this.state.scanning) return;
    const nav = this.window?.navigator;
    if (!nav?.mediaDevices?.getUserMedia) {
      this.window?.alert?.('Este dispositivo no permite acceder a la cámara desde el navegador.');
      return;
    }
    try {
      await this.initDevices();
      const constraints = { video: { width: { ideal: 1280 }, height: { ideal: 720 } } };
      if (this.state.currentDeviceId) {
        constraints.video.deviceId = { exact: this.state.currentDeviceId };
      } else {
        constraints.video.facingMode = { ideal: 'environment' };
      }
      const stream = await nav.mediaDevices.getUserMedia(constraints);
      const video = this.refs.video;
      if (!video) return;
      video.srcObject = stream;
      await video.play();
      this.state.scanning = true;
      if (this.refs.startBtn) this.refs.startBtn.disabled = true;
      if (this.refs.stopBtn) this.refs.stopBtn.disabled = false;
      if (this.refs.scanOnceBtn) this.refs.scanOnceBtn.disabled = false;
      this.refs.pulse?.classList.add('on');
      this.setScanLabel('Escaneando…');
      const track = stream.getVideoTracks?.()[0];
      const torchCapable = !!track?.getCapabilities?.().torch;
      if (this.refs.flashBtn) this.refs.flashBtn.disabled = !torchCapable;
      if (this.refs.switchBtn) this.refs.switchBtn.disabled = this.state.cameraDevices.length < 2;
      await this.ensureDetectionEngine();
      this.lastDetectTs = 0;
      this.window?.requestAnimationFrame(this.detectLoop);
    } catch (error) {
      console.error('No se pudo iniciar la cámara', error);
      this.window?.alert?.('No se pudo acceder a la cámara. Revisá permisos.');
      this.stopCamera();
    }
  }

  stopCamera() {
    const video = this.refs.video;
    const stream = video?.srcObject;
    if (stream) {
      stream.getTracks?.().forEach((track) => track.stop());
      video.srcObject = null;
    }
    this.state.scanning = false;
    this.manualScanBusy = false;
    this.refs.pulse?.classList.remove('on');
    if (this.refs.startBtn) this.refs.startBtn.disabled = false;
    if (this.refs.stopBtn) this.refs.stopBtn.disabled = true;
    if (this.refs.scanOnceBtn) this.refs.scanOnceBtn.disabled = true;
    if (this.refs.flashBtn) {
      this.refs.flashBtn.disabled = true;
      this.refs.flashBtn.textContent = 'Flash';
    }
    if (this.refs.switchBtn) {
      this.refs.switchBtn.disabled = this.state.cameraDevices.length < 2;
    }
    if (!this.refs.detectedCode?.value) {
      this.refs.copyBtn && (this.refs.copyBtn.disabled = true);
      this.refs.confirmBtn && (this.refs.confirmBtn.disabled = true);
      this.refs.confirmBtnMobile && (this.refs.confirmBtnMobile.disabled = true);
    }
    this.state.torchOn = false;
    this.setScanLabel('Cámara inactiva');
    if (this.detectLoopHandle) {
      this.window?.cancelAnimationFrame?.(this.detectLoopHandle);
      this.detectLoopHandle = null;
    }
    if (this.state.detector) {
      this.state.detector = null;
    }
    if (this.state.fallbackReader?.reset) {
      this.state.fallbackReader.reset();
    }
    this.state.fallbackReader = null;
    this.detectionCanvas = null;
    this.detectionCanvasCtx = null;
  }

  async toggleTorch() {
    const video = this.refs.video;
    const stream = video?.srcObject;
    const track = stream?.getVideoTracks?.()[0];
    const capabilities = track?.getCapabilities?.();
    if (!track || !capabilities?.torch) {
      this.window?.alert?.('El flash no está disponible en este dispositivo.');
      return;
    }
    this.state.torchOn = !this.state.torchOn;
    await track.applyConstraints({ advanced: [{ torch: this.state.torchOn }] });
    if (this.refs.flashBtn) {
      this.refs.flashBtn.textContent = this.state.torchOn ? 'Flash (ON)' : 'Flash';
    }
  }

  async switchCamera() {
    if (this.state.cameraDevices.length < 2) return;
    const index = this.state.cameraDevices.findIndex((device) => device.deviceId === this.state.currentDeviceId);
    const next = this.state.cameraDevices[(index + 1) % this.state.cameraDevices.length];
    if (!next) return;
    this.state.currentDeviceId = next.deviceId;
    this.stopCamera();
    await this.startCamera();
  }

  isVideoReady(video) {
    return !!(video && video.readyState >= 2 && video.videoWidth && video.videoHeight);
  }

  captureCanvasFrame(video) {
    if (!this.isVideoReady(video)) return null;
    if (!this.detectionCanvas) {
      this.detectionCanvas = this.document.createElement('canvas');
      this.detectionCanvasCtx = this.detectionCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (!this.detectionCanvasCtx) return null;
    if (this.detectionCanvas.width !== video.videoWidth || this.detectionCanvas.height !== video.videoHeight) {
      this.detectionCanvas.width = video.videoWidth;
      this.detectionCanvas.height = video.videoHeight;
    }
    this.detectionCanvasCtx.drawImage(video, 0, 0, this.detectionCanvas.width, this.detectionCanvas.height);
    return this.detectionCanvas;
  }

  async getSupportedBarcodeFormats() {
    if (!('BarcodeDetector' in (this.window || {}))) return [];
    if (this.barcodeDetectorFormatsCache) return this.barcodeDetectorFormatsCache;
    if (!this.barcodeDetectorFormatsPromise) {
      this.barcodeDetectorFormatsPromise = (async () => {
        if (typeof this.window.BarcodeDetector.getSupportedFormats === 'function') {
          try {
            const supported = await this.window.BarcodeDetector.getSupportedFormats();
            if (Array.isArray(supported) && supported.length) {
              const filtered = BARCODE_FORMATS.filter((format) => supported.includes(format));
              return filtered.length ? filtered : supported;
            }
          } catch (error) {
            console.warn('No se pudieron obtener formatos soportados', error);
          }
        }
        return BARCODE_FORMATS.slice();
      })()
        .then((list) => {
          this.barcodeDetectorFormatsCache = Array.isArray(list) ? list : BARCODE_FORMATS.slice();
          return this.barcodeDetectorFormatsCache;
        })
        .catch((error) => {
          console.warn('Fallo resolviendo formatos para BarcodeDetector', error);
          this.barcodeDetectorFormatsCache = [];
          return this.barcodeDetectorFormatsCache;
        });
    }
    await this.barcodeDetectorFormatsPromise;
    return this.barcodeDetectorFormatsCache;
  }

  async ensureBarcodeDetector() {
    if (this.barcodeDetectorAvailable === false) return null;
    if (!('BarcodeDetector' in (this.window || {}))) {
      this.barcodeDetectorAvailable = false;
      return null;
    }
    if (this.state.detector) return this.state.detector;
    try {
      const formats = await this.getSupportedBarcodeFormats();
      this.state.detector = formats?.length
        ? new this.window.BarcodeDetector({ formats })
        : new this.window.BarcodeDetector();
      this.barcodeDetectorAvailable = true;
      this.setChip(this.refs.apiStatus, 'API: BarcodeDetector', true);
      this.state.fallbackErrorShown = false;
      return this.state.detector;
    } catch (error) {
      this.barcodeDetectorAvailable = false;
      this.state.detector = null;
      console.warn('BarcodeDetector no disponible, intentando ZXing', error);
      return null;
    }
  }

  configureZXingReader(reader, ZX) {
    if (!reader || !ZX) return;
    try {
      const hints = new Map();
      const formats = [];
      for (const key of BARCODE_FORMATS) {
        const mapped = ZXING_FORMAT_MAP[key];
        if (mapped && ZX.BarcodeFormat?.[mapped]) {
          formats.push(ZX.BarcodeFormat[mapped]);
        }
      }
      if (formats.length && ZX.DecodeHintType?.POSSIBLE_FORMATS) {
        hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, formats);
      }
      if (ZX.DecodeHintType?.TRY_HARDER) {
        hints.set(ZX.DecodeHintType.TRY_HARDER, true);
      }
      if (typeof reader.setHints === 'function') {
        reader.setHints(hints);
      }
    } catch (error) {
      console.warn('No se pudieron configurar hints para ZXing', error);
    }
  }

  async ensureFallbackReader() {
    if (this.state.fallbackReader) return this.state.fallbackReader;
    const ZX = await this.ensureZXing();
    if (!ZX?.BrowserMultiFormatReader) return null;
    const reader = new ZX.BrowserMultiFormatReader();
    if ('timeBetweenDecodingAttempts' in reader) {
      reader.timeBetweenDecodingAttempts = DETECT_EVERY_MS;
    }
    if ('timeBetweenScansMillis' in reader) {
      reader.timeBetweenScansMillis = DETECT_EVERY_MS;
    }
    this.configureZXingReader(reader, ZX);
    this.state.fallbackReader = reader;
    this.setChip(this.refs.apiStatus, 'API: ZXing (fallback)', true);
    this.state.fallbackErrorShown = false;
    return this.state.fallbackReader;
  }

  handleNoDetectionAvailable() {
    this.setChip(this.refs.apiStatus, 'API: no disponible (sin ZXing)', false);
    if (!this.state.fallbackErrorShown) {
      this.window?.alert?.('Este navegador no soporta BarcodeDetector y no se pudo cargar ZXing. Usá el ingreso manual.');
      this.state.fallbackErrorShown = true;
    }
  }

  async ensureDetectionEngine() {
    const detector = await this.ensureBarcodeDetector();
    if (detector) return 'detector';
    const fallback = await this.ensureFallbackReader();
    if (fallback) return 'fallback';
    this.handleNoDetectionAvailable();
    return null;
  }

  async detectWithNative(detector, video) {
    if (!detector || !this.isVideoReady(video)) return null;
    const attempts = [];
    if (this.barcodeDetectorSupportsVideo !== false) {
      attempts.push(async () => ({ kind: 'video', source: video }));
    }
    if (typeof this.window?.createImageBitmap === 'function' && this.barcodeDetectorSupportsBitmap !== false) {
      attempts.push(async () => {
        const bitmap = await this.window.createImageBitmap(video);
        return { kind: 'bitmap', source: bitmap, cleanup: () => bitmap.close() };
      });
    }
    attempts.push(async () => {
      const canvas = this.captureCanvasFrame(video);
      return canvas ? { kind: 'canvas', source: canvas } : null;
    });

    for (const attempt of attempts) {
      let payload = null;
      try {
        payload = await attempt();
        if (!payload?.source) continue;
        const codes = await detector.detect(payload.source);
        if (codes?.length) {
          const first = codes[0];
          const value = first?.rawValue || first?.displayValue || '';
          if (value) {
            payload.cleanup?.();
            return value;
          }
        }
      } catch (error) {
        if (payload?.kind === 'video') {
          this.barcodeDetectorSupportsVideo = false;
          if (error?.name !== 'TypeError') {
            console.warn('Error detectando con BarcodeDetector (video)', error);
          }
        } else if (payload?.kind === 'bitmap') {
          this.barcodeDetectorSupportsBitmap = false;
          console.warn('Error generando ImageBitmap para BarcodeDetector', error);
        } else {
          console.warn('Error detectando con BarcodeDetector', error);
        }
      } finally {
        try {
          payload?.cleanup?.();
        } catch (cleanupError) {
          console.warn('Error liberando recursos de detección', cleanupError);
        }
      }
    }
    return null;
  }

  isZXingExpectedError(error, ZX) {
    if (!error) return true;
    if (error?.message === 'ZXING_TIMEOUT') return true;
    const name = error?.name;
    if (ZX && (
      error instanceof ZX.NotFoundException
      || error instanceof ZX.ChecksumException
      || error instanceof ZX.FormatException
    )) {
      return true;
    }
    if (name && ['NotFoundException', 'ChecksumException', 'FormatException'].includes(name)) {
      return true;
    }
    return false;
  }

  async detectWithFallback(video, { manual = false } = {}) {
    const reader = await this.ensureFallbackReader();
    if (!reader || !this.isVideoReady(video)) return null;
    const ZX = this.window?.ZXing;
    const canvas = this.captureCanvasFrame(video);
    if (!canvas) return null;
    try {
      const result = await reader.decodeFromCanvas(canvas);
      if (result?.text) {
        return result.text;
      }
    } catch (error) {
      if (!this.isZXingExpectedError(error, ZX)) {
        console.warn('Error detectando con ZXing', error);
      }
      if (manual) {
        throw error;
      }
    }
    return null;
  }

  async runDetection(video, { manual = false } = {}) {
    const engine = await this.ensureDetectionEngine();
    if (!engine) return null;
    if (engine === 'detector') {
      const value = await this.detectWithNative(this.state.detector, video);
      return value ? { text: value } : null;
    }
    if (engine === 'fallback') {
      const value = await this.detectWithFallback(video, { manual });
      return value ? { text: value } : null;
    }
    return null;
  }

  async detectLoop() {
    if (!this.state.scanning) return;
    const video = this.refs.video;
    if (!this.isVideoReady(video)) {
      this.detectLoopHandle = this.window?.requestAnimationFrame(this.detectLoop);
      return;
    }
    const now = this.window?.performance?.now?.() ?? Date.now();
    if (!this.lastDetectTs || now - this.lastDetectTs >= DETECT_EVERY_MS) {
      try {
        const result = await this.runDetection(video);
        if (result?.text) {
          this.onDetect(result.text);
          this.lastDetectTs = now;
        }
      } catch (error) {
        console.warn('detectLoop error', error);
      }
    }
    this.detectLoopHandle = this.window?.requestAnimationFrame(this.detectLoop);
  }

  async scanOnce() {
    if (this.manualScanBusy) return;
    if (!this.state.scanning) {
      this.window?.alert?.('Iniciá la cámara para ejecutar una lectura.');
      return;
    }
    const video = this.refs.video;
    if (!video?.srcObject) {
      this.window?.alert?.('No hay una cámara activa. Iniciá la cámara.');
      return;
    }
    this.manualScanBusy = true;
    const button = this.refs.scanOnceBtn;
    const previousText = button?.textContent || '';
    if (button) {
      button.disabled = true;
      button.textContent = 'Leyendo…';
    }
    this.setScanLabel('Buscando código…');
    let detected = false;
    try {
      if (!this.isVideoReady(video)) {
        await new Promise((resolve) => this.window?.setTimeout(resolve, MANUAL_DETECT_DELAY_MS));
      }
      if (this.isVideoReady(video)) {
        const result = await this.runDetection(video, { manual: true });
        if (result?.text) {
          detected = true;
          this.onDetect(result.text);
        }
      }
      this.setScanLabel(detected ? 'Código detectado' : 'Sin resultados', 1800);
    } catch (error) {
      console.warn('scanOnce error', error);
      this.setScanLabel('Error en lectura', 2000);
    } finally {
      if (this.state.scanning) {
        this.lastDetectTs = this.window?.performance?.now?.() ?? Date.now();
      }
      if (button) {
        button.textContent = previousText || 'Lectura única';
        if (this.state.scanning) {
          button.disabled = false;
        }
      }
      this.manualScanBusy = false;
    }
  }

  onDetect(code) {
    const normalized = String(code || '').trim();
    if (!normalized) return;
    const now = Date.now();
    if (this.state.lastScan.code === normalized && now - this.state.lastScan.time < 3000) {
      return;
    }
    this.state.lastScan = { code: normalized, time: now };
    if (this.refs.detectedCode) {
      this.refs.detectedCode.value = normalized;
    }
    if (this.refs.copyBtn) {
      this.refs.copyBtn.disabled = false;
    }
    if (this.refs.confirmBtn) {
      this.refs.confirmBtn.disabled = false;
    }
    if (this.refs.confirmBtnMobile) {
      this.refs.confirmBtnMobile.disabled = false;
    }
    const row = this.state.index.get(normalized);
    if (row) {
      this.setChip(this.refs.matchChip, 'Coincide en inventario', true);
      this.paintDetails(row);
      this.flashOK();
    } else {
      this.setChip(this.refs.matchChip, 'No encontrado en inventario', false);
      this.clearDetails();
      this.flashWarn();
    }
  }

  confetti(x = (this.window?.innerWidth || 0) / 2, y = (this.window?.innerHeight || 0) / 2) {
    if (!this.document || !this.window) return;
    const canvas = this.document.createElement('canvas');
    canvas.style.position = 'fixed';
    canvas.style.left = '0';
    canvas.style.top = '0';
    canvas.style.width = '100vw';
    canvas.style.height = '100vh';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '9999';
    this.document.body.appendChild(canvas);
    canvas.width = this.window.innerWidth;
    canvas.height = this.window.innerHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      canvas.remove();
      return;
    }
    const pieces = Array.from({ length: 110 }, () => ({
      x,
      y,
      vx: (Math.random() - 0.5) * 6,
      vy: (Math.random() * -6) - 3,
      w: 2 + Math.random() * 3,
      h: 6 + Math.random() * 6,
      rotation: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.2,
      life: 120 + Math.random() * 60,
      color: `hsl(${Math.random() * 360}, 90%, 70%)`,
    }));
    let tick = 0;
    const raf = this.window.requestAnimationFrame?.bind(this.window)
      || ((fn) => this.window.setTimeout(fn, 16));
    const loop = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      pieces.forEach((piece) => {
        const item = piece;
        item.vy += 0.12;
        item.x += item.vx;
        item.y += item.vy;
        item.rotation += item.vr;
        item.life -= 1;
        ctx.save();
        ctx.translate(item.x, item.y);
        ctx.rotate(item.rotation);
        ctx.fillStyle = item.color;
        ctx.fillRect(-item.w / 2, -item.h / 2, item.w, item.h);
        ctx.restore();
      });
      tick += 1;
      if (tick < 180) {
        raf(loop);
      } else {
        canvas.remove();
      }
    };
    raf(loop);
  }

  expose() {
    return {
      state: this.state,
      parseCSV: this.parseCSV.bind(this),
      parseCSVAuto: this.parseCSVAuto.bind(this),
      detectDelimiter: this.detectDelimiter.bind(this),
      uniqueColumnNames: this.uniqueColumnNames.bind(this),
      normalizeRowValue: this.normalizeRowValue.bind(this),
      hydrateInventory: this.hydrateInventory.bind(this),
      rebuildIndex: this.rebuildIndex.bind(this),
      setInventoryStatus: this.setInventoryStatus.bind(this),
      loadFile: this.loadFile.bind(this),
      loadDefaultInventory: this.loadDefaultInventory.bind(this),
      paintInventory: this.paintInventory.bind(this),
      paintConformados: this.paintConformados.bind(this),
      paintDetails: this.paintDetails.bind(this),
      clearDetails: this.clearDetails.bind(this),
      addConformado: this.addConformado.bind(this),
      exportCSV: this.exportCSV.bind(this),
      startCamera: this.startCamera.bind(this),
      stopCamera: this.stopCamera.bind(this),
      toggleTorch: this.toggleTorch.bind(this),
      switchCamera: this.switchCamera.bind(this),
      scanOnce: this.scanOnce.bind(this),
      detectLoop: this.detectLoop.bind(this),
      onDetect: this.onDetect.bind(this),
      confetti: this.confetti.bind(this),
      setChip: this.setChip.bind(this),
      setScanLabel: this.setScanLabel.bind(this),
      updateInventoryIndicators: this.updateInventoryIndicators.bind(this),
      toggleInventoryDrawer: this.toggleInventoryDrawer.bind(this),
      ensureZXing: this.ensureZXing.bind(this),
      ensureSheetJS: this.ensureSheetJS.bind(this),
      persistConformados: this.persistConformados.bind(this),
      restoreConformados: this.restoreConformados.bind(this),
      stateSnapshot: () => JSON.parse(JSON.stringify(this.state)),
    };
  }
}

const documentRef = typeof document !== 'undefined' ? document : undefined;
const appInstance = new ScanControlApp(documentRef);

if (typeof window !== 'undefined') {
  window.__SCAN__ = appInstance.expose();
  window.addEventListener('DOMContentLoaded', () => appInstance.bootstrap());
}
