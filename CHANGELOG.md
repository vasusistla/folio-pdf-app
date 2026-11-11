# Changelog

Every change to Folio PDF gets a new version number, written as **MAJOR.MINOR.PATCH**:

- **PATCH**, e.g. 1.1.0 → 1.1.1: bug fixes only
- **MINOR**, e.g. 1.1.0 → 1.2.0: new features; nothing you use is removed
- **MAJOR**, e.g. 1.x → 2.0.0: big changes to how the app works

A number is never reused. The app reads the notes for its own version from this file and shows them in **Help → About Folio PDF**.

## 1.5.0 — 2026-11-11
Scans that look like real PDFs, even from bent paper.
- **Bent pages come out flat.** A page that was folded, creased, curled at the edge or bowed when you took the picture is laid flat: its curved edges are followed and its lines of text are straightened again, the way scanner apps do. Pages that were already flat are left exactly as they were.
- **Fold and curl shadows are lifted.** The gray band along a crease, or the darker edge of a curl, now comes out white like the rest of the paper. Coloured marks (a highlighter, a coloured box) are kept.
- **Sharper text.** Letters come out crisper after straightening.
- A **Flatten bent pages** switch under Look turns the flattening off, if you ever want the page exactly as photographed (it's on unless you turn it off).
- Searchable text is read from the flattened page, so more words are found on bent pages.

## 1.4.0 — 2026-11-11
iPhone and iPad release.
- Folio PDF now runs on iPhone and iPad (and in any up-to-date web browser). It's the same app: reading, search, Fill & Sign, signatures, page edits, scanning and searchable text. Open its web address in Safari once, then Share → Add to Home Screen; after that it opens like an app and works offline.
- On the phone: open PDFs from the Files app (iCloud Drive, On My iPhone, other apps' folders). Saving keeps the document in Folio, and a Share button saves a copy to Files or sends it by Mail, Messages or AirDrop.
- Recent files reopen straight from Folio on the phone, even offline.
- The menu bar becomes a ☰ menu on the phone; the toolbar scrolls sideways.
- Scanning on the phone uses the rear camera, or photos from the photo library (HEIC is fine there). Look and Save open as panels from the bottom.
- Pinch with two fingers to zoom the pages, and double-tap to zoom in or back to the page width (phones, tablets and touchscreen laptops).
- Scan crop fixed: the corner and side handles now follow your finger, pen or mouse smoothly for the whole drag (in 1.3.0 they let go after the first small movement). You can grab a handle from a little way off, and on touch screens the magnifier sits above your finger.
- Very large photos (24 megapixels and up) are scaled to fit before scanning.
- Documents never leave the device. When a new version is published, the app offers to update.

## 1.3.0 — 2026-11-11
Scan release.
- New Scan to PDF (camera button on the toolbar, File → Scan to PDF…, or Ctrl+Shift+N). Point your laptop's camera, or a USB document camera, at a page: Folio outlines it live and takes the picture when it holds still (Auto-capture), or when you press Space. Take as many pages as you like.
- Each page is found in the photo, straightened (even when photographed at an angle) and cleaned up: shadows and uneven light are removed and the paper comes out white. Choose a look per page: Auto, Grayscale, Black & white or Photo.
- Check the pages before saving: drag to reorder, crop by dragging the corners (with a magnifier), turn, retake or delete.
- Make a PDF from photos you already have, for example from your phone: File → PDF from Photos…, or drag the photos onto the window. JPEG, PNG, WebP, BMP and GIF; the app explains how to get JPEG from an iPhone that saves HEIC.
- Save as a new PDF, or add the pages to the open PDF (after this page, at the start or at the end). Page size matches the paper automatically (Letter, A4 or Legal), or choose one. Three quality settings control file size.
- Scanned text is searchable: words are recognised on this computer (English) and added invisibly, so you can search, select and copy them. Pages photographed sideways or upside down are turned the right way up.
- New Pages → Recognize Text (Make Searchable)… does the same for scanned PDFs you already have. Pages that already have text are left alone.
- The camera is used only while the scanner is open, video only, and nothing is recorded or sent anywhere; the app stays fully offline.

## 1.2.0 — 2026-11-04
Fill & Sign release.
- New Fill & Sign mode (toolbar button, or Ctrl+Shift+F) for filling in any PDF, including flat forms and contracts that have no form fields.
- Blanks are found automatically and highlighted: underlines, runs of underscores in the middle of sentences, boxes, empty table cells, checkboxes and signature fields. Click one to fill it; Tab jumps to the next.
- Text you type sits on the line and shrinks to fit the blank. You can also add ✓ ✕ ● marks and today's date.
- Adopt your signature and initials by typing your name (five handwriting styles), drawing it, or uploading a photo, which has its paper background removed. They are kept only on this computer.
- Signature lines and signature fields are recognised and highlighted in yellow; your signature is sized to fit them.
- Move, resize, delete and undo anything you add. Changing the view (rotate or zoom) keeps everything in place.
- On Save and Print, everything you filled in is written into the page, so it looks the same in any PDF reader and on paper.
- Undo and Redo now cover annotations and Fill & Sign together.

## 1.1.0 — 2026-11-03
Offline and security release.
- The app never connects to the internet. It's blocked at six independent levels, and the app opens no network ports.
- Web links inside PDFs no longer open your browser; the app shows the address with a Copy button instead.
- Hardened the Windows program so other software can't use it to run its own code.
- Added "Block internet for Folio PDF.cmd" to lock the app with Windows Firewall.
- Added SECURITY.md: what protects you and how to check it yourself.
- The version number and these notes now appear in Help → About, and the app tells you when it has been updated.

## 1.0.0 — 2026-11-03
First release.
- Reading: thumbnails, bookmarks, search, zoom, rotate, page layouts, presentation mode, dark theme, night reading, recent files, reopens at the last page, password-protected PDFs, forms, document properties, printing.
- Editing: highlight, text, drawing, images, undo and redo; rotate, delete, move and insert pages; extract pages; add other PDFs; add page numbers.
- Note: a second build was mistakenly also labelled 1.0.0. It already had most of the 1.1.0 offline changes. Replace any file with "1.0.0" in its name with version 1.1.0.
