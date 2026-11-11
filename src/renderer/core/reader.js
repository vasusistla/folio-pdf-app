/**
 * Reader: owns the open document and the PDF.js viewer.
 *
 * Features talk to the document through this object, never to PDF.js
 * internals directly, so a PDF.js upgrade only touches this file.
 *
 * Events (reader.on(name, fn)):
 *   open(doc)  close()  loading(bool)  page(number)  scale({ scale, value })
 *   rotation(deg)  dirty(bool)  editor-mode(mode)  editor-state(details)
 */
import { Emitter, debounce } from './emitter.js';
import { pdfjsLib, viewer, DOCUMENT_OPTIONS, IMAGE_RESOURCES } from './pdf.js';

const { EventBus, PDFLinkService, PDFFindController, PDFViewer, LinkTarget } = viewer;
const { AnnotationEditorType, PasswordResponses } = pdfjsLib;

export const HIGHLIGHT_COLORS = { yellow: '#FFFF98', green: '#53FFBC', blue: '#80EBFF', pink: '#FFCBE6', red: '#FF4F5F' };

export class Reader extends Emitter {
  doc = null;
  /** { path, name, size } for the open document; path is null for unsaved new documents */
  file = null;
  uiManager = null;
  editorState = {};

  #host;
  #ui;
  #seq = 0;
  #contentDirty = false;
  #annotDirty = false;
  #editorMode = AnnotationEditorType.NONE;
  #transforms = [];
  #featureDirty = new Set();

  constructor({ container, viewerEl, host, ui }) {
    super();
    this.#host = host;
    this.#ui = ui;
    this.container = container;

    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK, externalLinkRel: 'noopener noreferrer nofollow' });
    const findController = new PDFFindController({ eventBus, linkService });
    const pdfViewer = new PDFViewer({
      container,
      viewer: viewerEl,
      eventBus,
      linkService,
      findController,
      annotationEditorMode: AnnotationEditorType.NONE,
      annotationEditorHighlightColors: Object.entries(HIGHLIGHT_COLORS).map(([k, v]) => `${k}=${v}`).join(','),
      enableHighlightFloatingButton: true,
      imageResourcesPath: IMAGE_RESOURCES,
      maxCanvasPixels: 2 ** 25,
    });
    linkService.setViewer(pdfViewer);
    Object.assign(this, { eventBus, linkService, findController, pdfViewer });

    eventBus.on('pagechanging', ({ pageNumber }) => { this.emit('page', pageNumber); this.#savePosition(); });
    eventBus.on('scalechanging', ({ scale, presetValue }) => { this.emit('scale', { scale, value: presetValue || scale }); this.#savePosition(); });
    eventBus.on('rotationchanging', ({ pagesRotation }) => this.emit('rotation', pagesRotation));
    eventBus.on('annotationeditoruimanager', ({ uiManager }) => { this.uiManager = uiManager; });
    eventBus.on('annotationeditormodechanged', ({ mode }) => { this.#editorMode = mode; this.emit('editor-mode', mode); });
    eventBus.on('editingstateschanged', ({ details }) => { this.editorState = { ...details }; this.emit('editor-state', this.editorState); });

    this.#savePosition = debounce(() => {
      if (this.file?.path && this.doc) {
        this.#host.setPosition(this.file.path, { page: this.pageNumber, scale: this.pdfViewer.currentScaleValue });
      }
    }, 700);
  }

  #savePosition;

  // ------------------------------------------------------------- getters
  get hasDocument() { return !!this.doc; }
  get pageCount() { return this.doc?.numPages || 0; }
  get pageNumber() { return this.doc ? this.pdfViewer.currentPageNumber : 0; }
  get scale() { return this.pdfViewer.currentScale; }
  get scaleValue() { return this.pdfViewer.currentScaleValue; }
  get rotation() { return this.pdfViewer.pagesRotation; }
  get dirty() { return this.#contentDirty || this.#annotDirty || this.#featureDirty.size > 0; }
  /** True when a feature (e.g. Fill & Sign) has content that is only added to the PDF when saving. */
  get hasPendingTransforms() { return this.#transforms.some((t) => t.needed()); }
  get editorMode() { return this.#editorMode; }
  get canEdit() { return !!this.doc && this.pdfViewer.annotationEditorMode !== AnnotationEditorType.DISABLE; }

  // ------------------------------------------------------------- navigation
  goToPage(n) {
    if (!this.doc) return;
    this.pdfViewer.currentPageNumber = Math.max(1, Math.min(this.pageCount, Math.round(n)));
  }
  nextPage() { if (this.doc) this.pdfViewer.nextPage(); }
  previousPage() { if (this.doc) this.pdfViewer.previousPage(); }

  /** 'auto' | 'page-fit' | 'page-width' | 'page-actual' | number (1 = 100%) */
  setScale(value) { if (this.doc) this.pdfViewer.currentScaleValue = String(value); }
  zoomIn(opts = {}) { if (this.doc) this.pdfViewer.increaseScale(opts); }
  zoomOut(opts = {}) { if (this.doc) this.pdfViewer.decreaseScale(opts); }
  rotate(delta) { if (this.doc) this.pdfViewer.pagesRotation = (this.pdfViewer.pagesRotation + delta + 360) % 360; }

  // ------------------------------------------------------------- open / close
  async openPath(filePath, opts) {
    const file = await this.#host.readFile(filePath);
    return this.open(file, opts);
  }

  /**
   * Open a document from bytes.
   * file: { data: Uint8Array, path?, name, size? }
   * opts: { page, scale, dirty, replace } (replace keeps the file identity, used after page edits)
   */
  async open(file, opts = {}) {
    const seq = ++this.#seq;
    let userCancelled = false;
    this.emit('loading', true);
    try {
      const task = pdfjsLib.getDocument({ ...DOCUMENT_OPTIONS, data: file.data });
      task.onPassword = (updatePassword, reason) => {
        const wrong = reason === PasswordResponses.INCORRECT_PASSWORD;
        this.#ui.prompt({
          title: 'Password required',
          label: wrong ? 'That password is incorrect. Try again:' : `"${file.name}" is protected. Enter its password to open it:`,
          type: 'password', okLabel: 'Open',
        }).then((pw) => {
          if (pw === null) { userCancelled = true; task.destroy(); } else updatePassword(pw);
        });
      };
      const doc = await task.promise;
      if (seq !== this.#seq) { doc.destroy(); return false; }

      const restore = opts.replace ? null : (file.path ? await this.#host.getPosition(file.path) : null);
      const page = opts.page ?? restore?.page ?? 1;
      const scale = opts.scale ?? restore?.scale ?? 'auto';

      await this.#teardown();
      this.doc = doc;
      this.file = { path: file.path || null, name: file.name || 'Untitled.pdf', size: file.size ?? file.data?.byteLength ?? 0 };
      this.#contentDirty = !!opts.dirty;
      this.#annotDirty = false;
      doc.annotationStorage.onSetModified = () => this.#setAnnotDirty(true);
      doc.annotationStorage.onResetModified = () => this.#setAnnotDirty(false);

      this.eventBus.on('pagesinit', () => {
        this.pdfViewer.currentScaleValue = String(scale);
        if (page > 1) this.pdfViewer.currentPageNumber = Math.min(page, doc.numPages);
      }, { once: true });
      this.pdfViewer.setDocument(doc);
      this.linkService.setDocument(doc, null);

      if (this.file.path && !opts.replace) this.#host.addRecent(this.file.path);
      this.#syncWindow();
      this.emit('open', doc, { replaced: !!opts.replace });
      return true;
    } catch (err) {
      if (seq !== this.#seq || userCancelled) return false;
      throw friendlyError(err, file.name);
    } finally {
      if (seq === this.#seq) this.emit('loading', false);
    }
  }

  async close() {
    this.#seq++;
    await this.#teardown();
    this.#syncWindow();
    this.emit('close');
  }

  async #teardown() {
    if (!this.doc) return;
    this.#savePosition.cancel?.();
    if (this.file?.path) this.#host.setPosition(this.file.path, { page: this.pageNumber, scale: this.pdfViewer.currentScaleValue });
    const old = this.doc;
    this.doc = null;
    this.uiManager = null;
    this.editorState = {};
    this.#editorMode = AnnotationEditorType.NONE;
    this.pdfViewer.setDocument(null);
    this.linkService.setDocument(null, null);
    this.#contentDirty = this.#annotDirty = false;
    this.#featureDirty.clear();
    await old.destroy();
  }

  // ------------------------------------------------------------- editing & saving
  /**
   * Current document bytes, including annotations, form values and anything features add
   * when saving (registered with addSaveTransform). Always start edits from these bytes.
   */
  async getBytes() {
    if (!this.doc) throw new Error('No document is open');
    let bytes = this.doc.annotationStorage.size > 0 ? await this.doc.saveDocument() : await this.doc.getData();
    for (const t of this.#transforms) {
      if (t.needed()) bytes = await t.apply(bytes, this.doc);
    }
    return bytes;
  }

  /**
   * Let a feature write its content into the PDF whenever bytes are produced (save, print, page edits).
   * { id, needed(): boolean, apply(bytes, pdfjsDoc): Promise<Uint8Array> }
   */
  addSaveTransform(transform) {
    this.#transforms.push(transform);
    return () => { this.#transforms = this.#transforms.filter((t) => t !== transform); };
  }

  /** Features with their own unsaved state call this, e.g. setFeatureDirty('fill-sign', true). */
  setFeatureDirty(name, isDirty) {
    const had = this.#featureDirty.has(name);
    if (isDirty) this.#featureDirty.add(name); else this.#featureDirty.delete(name);
    if (had !== !!isDirty) { this.#syncWindow(); this.emit('dirty', this.dirty); }
  }

  /** Swap in edited bytes (from pdf-lib etc.) but keep the same file, page and zoom. */
  async replaceBytes(bytes, { page } = {}) {
    const keep = { page: page ?? this.pageNumber, scale: this.pdfViewer.currentScaleValue };
    const file = { ...this.file, data: bytes, size: bytes.byteLength };
    return this.open(file, { ...keep, dirty: true, replace: true });
  }

  /** Call after the bytes were written to disk. */
  markSaved(info) {
    if (info) this.file = { ...this.file, ...info };
    this.#contentDirty = false;
    this.doc?.annotationStorage.resetModified();
    this.#annotDirty = false;
    this.#featureDirty.clear();
    this.#syncWindow();
    this.emit('saved');
    this.emit('dirty', false);
  }

  /** AnnotationEditorType.NONE | HIGHLIGHT | FREETEXT | INK | STAMP */
  setEditorMode(mode) {
    if (!this.canEdit) return false;
    this.pdfViewer.annotationEditorMode = { mode };
    return true;
  }

  #setAnnotDirty(v) {
    if (this.#annotDirty === v) return;
    this.#annotDirty = v;
    this.#syncWindow();
    this.emit('dirty', this.dirty);
  }

  #syncWindow() {
    const name = this.file?.name;
    const title = this.doc ? `${this.dirty ? '● ' : ''}${name} — Folio PDF` : 'Folio PDF';
    document.title = title;
    this.#host.setWindowState({ filePath: this.doc ? this.file.path : null, dirty: this.doc ? this.dirty : false, title });
  }
}

function friendlyError(err, name) {
  const msg = String(err?.message || err);
  const e = new Error(
    /Invalid PDF|InvalidPDF/i.test(err?.name + msg) ? `"${name}" is not a valid PDF file, or it is damaged.`
      : /password/i.test(msg) ? `"${name}" could not be unlocked.`
        : `"${name}" could not be opened. ${msg}`);
  e.cause = err;
  return e;
}
